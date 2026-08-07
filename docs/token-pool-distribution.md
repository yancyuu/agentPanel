# Token 池一键分发：客户端流程 + 服务端待修问题

> 受众：agentbus / token-distribution-v3 服务端维护者。
> 目的：说明 agentpanel（客户端）**完整的认领分发流程**、它依赖的服务端契约，以及当前阻塞流程的**服务端 bug**。

---

## 1. 客户端（agentpanel）分发流程

用户在 agentpanel 终端菜单走「token 池 → 认领」，客户端按顺序调用 4 个 v3 接口，再把一次性明文 key 写入所选的本地 Claude Code / Codex 配置及系统环境变量：

```
discover → 选模型 → provision → poll → claim(一次性 key) → 快照原配置 → 写入 Claude/Codex
```

### 1.1 拉取可选模型目录
- `POST /api/v1/token-distribution-v3/aliyun/discover`
- body：`{ "region_id": "cn-shenzhen" }`
- 客户端读取：`model_apis[].http_api_id`（作为 model api 的唯一 id）、`model_apis[].name`、`model_apis[].models[]`
- 用户从列表里选一个模型，客户端取该 model api 的 `http_api_id` 进入下一步。

### 1.2 发起签发（异步）
- `POST /api/v1/token-distribution-v3/aliyun/auto-provision`
- body：
  ```json
  {
    "region_id": "cn-shenzhen",
    "api_name": "cpamc-openai",
    "use_default_credentials": true,
    "model_api_ids": ["<http_api_id>"]
  }
  ```
- 客户端读取：`run_id`（拿去轮询）。

### 1.3 轮询直到终态
- `GET /api/v1/token-distribution-v3/provisioning-runs/{run_id}`
- 客户端读到 `status ∈ {succeeded, success, completed}` 才继续；`failed` 即报错中止。

### 1.4 领取一次性明文 key（即焚）
- `POST /api/v1/token-distribution-v3/provisioning-runs/{run_id}/secrets/claim`
- 客户端读取：`key`（明文）、`endpoint`、`proxy_paths.openai_chat` / `proxy_paths.openai_responses`。

### 1.5 写入本地运行时配置与环境变量
领取到 key 后，客户端先快照原始文件到 `~/.hermit/agentpanel.env.bak`，再将 key 写入用户选择的运行时：

| 目标 | 写入内容 |
|---|---|
| `~/.claude/settings.json`（选择 Claude Code 时） | `env.ANTHROPIC_BASE_URL = endpoint`、`env.ANTHROPIC_AUTH_TOKEN = key` |
| `~/.codex/auth.json`（选择 Codex 时） | `OPENAI_API_KEY = key` |
| `~/.codex/config.toml`（选择 Codex 时） | `base_url = <由 proxy_paths 解析>`、`model`、`wire_api` |
| `~/.hermit/aikey.env`（0600） | 已认领标记，以及外部 agent 可手动 `source` 的 key/base URL exports |

客户端也在**认领时一次性**同步更新所选运行时的系统环境变量；不安装会在每次 shell 提示符执行的 hook：

| 平台 | 写入位置 | 何时生效 |
|---|---|---|
| macOS | `~/.zshrc` 的 `# >>> hermit aikey >>>` 管理块；另执行 `launchctl setenv` | 新终端；当前登录会话中新启动的 GUI 应用 |
| Linux | `~/.bashrc` 的同名管理块 | 新终端 |
| Windows | 当前用户的 Windows 环境变量（HKCU） | 新终端 |

Claude Code 导出 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`；Codex 导出 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。变量只对应用户在认领时选择的运行时。

---

## 2. 客户端侧已修复（与服务端无关，仅作记录）

- **字段名 bug**：1.2 的 body 字段曾误写为 `aliyun_model_api_ids`，服务端 body model 的真实字段是 **`model_api_ids`**。
  服务端那个 `aliyun_model_api_ids_required` 错误名有误导性——它是「body 里 `model_api_ids` 为空」时抛的，名字却带 `aliyun_` 前缀。
  客户端已改为 `model_api_ids`（已验证 provision 返回 200 + run_id）。**服务端无需处理此项**。

---

## 3. 服务端待修 Bug（当前阻塞所有中文用户名用户）

### Bug A：consumer_name 含中文 → 阿里云 CreateConsumer 400

**现象**：任何飞书显示名含中文的用户，provisioning run 必挂在倒数第二步「为飞书用户创建或复用阿里云消费者」。

**报错原文**：
```
step「为飞书用户创建或复用阿里云消费者」failed:
CreateConsumer: code: 400,
consumer name can only contain alphanumeric characters, dashes, dots,
now %s.%!(EXTRA string=aim-fs-于晓婕-fdb87934d9)
request id: 019F4BA0-813E-5401-8940-D35D139FBE20
```

**根因**：服务端用飞书**中文显示名**拼了 consumer_name。失败 run 实际发出的 request：
```json
{
  "consumer_name": "aim-fs-于晓婕-fdb87934d9",
  "subject_name":  "飞书用户 于晓婕",
  "owner_name":    "于晓婕",
  "owner_email":   "yuxiaojie1@skg.com"
}
```
阿里云 CreateConsumer 硬性规则：consumer name 只允许 `[a-zA-Z0-9.-]`，中文直接 400。
历史唯一成功的那条用的是 `consumer_name: "customer_test"`（纯 ASCII），所以没暴露。

**修复（一行级）**：拼 consumer_name 不要用 `display_name`，改用 ASCII 稳定标识。`/api/v1/auth/me` 已返回：
```json
"feishu": { "identity": { "open_id": "ou_c24154c4eba214dc3bbfb4694d40d682" } }
```
建议：
```go
// before（中文用户必挂）
consumerName := fmt.Sprintf("aim-fs-%s-%s", user.Name, shortHash)   // user.Name = "于晓婕"

// after
consumerName := fmt.Sprintf("aim-fs-%s", identity.OpenID)           // "aim-fs-ou_c24154c4..."
// 或 aim-fs-{hex(sha1(open_id))[:10]}
```
`open_id` 全局唯一、ASCII、稳定 → 同一用户每次复用同一 consumer（该步语义本就是「创建或复用」）。

**已验证旁证**：客户端显式传 ASCII `consumer_name: "agentpanel-yuxiaojie1"` 时，服务端采用该值，CreateConsumer 步通过，**网关资源 + Key 均成功创建**。根因 100% 是中文 consumer_name。

---

### Bug B：数据面冒烟 `auth_unavailable`（最终一致延迟，建议顺手治）

修完 Bug A 后，run 会跑到最后一步「数据面冒烟」，目前大概率挂这个：
```
数据面冒烟未通过（已重试 3 次）：
OpenAI: auth_unavailable: no auth available (providers=codex, model=gpt-5.2-pro)
```
此时 **Key 其实已经建好**，只是阿里云侧 auth 还没生效。建议：
- 冒烟步加重试间隔/退避（如 3 次 → 间隔 5–10s）；或
- 允许「冒烟未过但 Key 已建」也算 `succeeded`，把冒烟结果放 `summary` 供治理页复验。

---

## 4. 复现步骤（服务端排查用）

用任意已登录 agentpanel 的账号，或直接带 Bearer token 调：

```bash
# 1) discover（正常，返回 model_apis 列表）
curl -s -X POST "$BASE/api/v1/token-distribution-v3/aliyun/discover" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"region_id":"cn-shenzhen"}' | jq '.model_apis[0].http_api_id'

# 2) provision（Bug A：会拿到 run_id，但 run 最终 failed）
curl -s -X POST "$BASE/api/v1/token-distribution-v3/aliyun/auto-provision" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"region_id":"cn-shenzhen","api_name":"cpamc-openai","use_default_credentials":true,"model_api_ids":["<上面拿到的 http_api_id>"]}'
# → {"run_id":"...","status":"queued",...}

# 3) 看 run 详情，确认卡在「创建或复用消费者」、consumer_name 含中文
curl -s "$BASE/api/v1/token-distribution-v3/provisioning-runs/<run_id>" \
  -H "Authorization: Bearer $TOKEN" | jq '{status, error_message, request:{consumer_name,subject_name}, steps:[.steps[]|{name,status}]}'
```

`BASE` 当前为客户端配置的 token-distribution 服务端地址；`$TOKEN` 为登录态 bearer。

---

## 5. 对服务端的请求

1. **Bug A 必修**：consumer_name 改用 ASCII（`open_id` 或其 hash）。这是当前所有中文用户名用户完全无法用 token 池的直接原因。
2. **Bug B 建议修**：冒烟重试/退避或放宽终态判定。
3. 可选：`aliyun_model_api_ids_required` 这个错误名建议改成 `model_api_ids_required`，和真实字段名对齐，避免再误导排查。

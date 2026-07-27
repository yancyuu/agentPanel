<p align="center">
  <img src="resources/icons/png/1024x1024.png" alt="AgentCli" width="96" />
</p>

<h1 align="center">AgentCli</h1>

<p align="center"><strong>当前版本：v1.9.13</strong></p>

<p align="center">
  <strong>本地优先的 AI 数字员工工作台</strong><br/>
  CLI 给 agent，Web 给人。自动采集 Claude Code / Codex / Cursor 等运行时用量，统一管理数字员工团队。<br/>
  <sub>Local-first AI workforce workbench. CLI for agents, Web for humans.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@yancyyu/agentcli"><img src="https://img.shields.io/npm/v/@yancyyu/agentcli?style=flat-square&color=brightgreen" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@yancyyu/agentcli"><img src="https://img.shields.io/npm/dm/@yancyyu/agentcli?style=flat-square&color=brightgreen" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-brightgreen?style=flat-square" alt="AGPL-3.0 license" /></a>
</p>

<p align="center">
  <img src="docs/screenshots/agentcli/team-detail.png" alt="AgentCli team workspace" width="100%" />
</p>

---

## 这是什么

AgentCli 是一个**本地优先的 AI 数字员工工作台**。它让你像管理真实团队一样管理 AI Agent：组建团队、分配任务、追踪进度、审核交付——同时自动采集多种运行时（Claude Code、Codex、Cursor…）的用量并统一上报。

> **CLI for agents, Web for humans.** Web 工作台给人看和管；CLI 给 agent / operator 查询状态、上报用量、触发操作，所有命令支持 `--json` 输出机器可读结果。

### 解决的问题

- AI Agent 越来越多，但**谁在做什么、进展如何**没有统一视图
- 多种运行时各自独立，**无法协调管理与统一计量**
- 团队 AI 使用缺乏**可见性、归因和审计能力**

---

## 两个产品，一条路径

先把本机 AI 运行时管起来，需要团队化时再接入 AgentBus。

| 产品         | 定位                                                  | 适用场景                                       |
| :----------- | :---------------------------------------------------- | :--------------------------------------------- |
| **AgentCli** | 本地优先的 CLI + Web 工作台。你现在就能装、立刻能用。 | 单机使用、脚本化、自动化、本地数字员工团队     |
| **AgentBus** | 中心化数据总线，把单机工具升级成团队 / 企业平台。     | 多人 / 多团队协作、IM 触发任务、企业级用量看板 |

> 关系一句话：**AgentCli 是本地操作面，AgentBus 是协调骨干。** 不接 Bus = 单机模式，照样完整能跑；接入 Bus 才解锁多人协作与企业能力。

---

## 30 秒快速体验

**一行安装（自带 Node 运行时，无需额外装环境）：**

```bash
# Windows（PowerShell）
irm https://yancyuu.github.io/agentcli/install.ps1 | iex

# macOS / Linux
curl -fsSL https://yancyuu.github.io/agentcli/install.sh | bash
```

装完**开一个新终端**运行 `agentcli`，浏览器打开 [http://127.0.0.1:5680](http://127.0.0.1:5680) 创建你的第一个数字员工团队。

<details>
<summary>或者用 npm / npx（适合已装 Node 的开发者）</summary>

```bash
# 免安装直接运行
npx @yancyyu/agentcli@latest init

# 或全局安装
npm install -g @yancyyu/agentcli@latest
agentcli
```

</details>

---

## 🤖 给 Agent 的最小上手路径（说明书）

> 把这段交给一个 AI agent，它能照着装好、登录、上报、自检。完整在线说明书：<https://yancyuu.github.io/agentcli/>，也可以直接把这个链接丢给 Claude Code / Codex。

```bash
# 1. 安装（三选一）
npm install -g @yancyyu/agentcli@latest      # 或 npx @yancyyu/agentcli@latest
agentcli init                                 # ✅ 快速启动 Web + 用量后台 worker

# 2. 登录上报目标（飞书授权绑定 AgentBus）
agentcli auth login
agentcli auth status                          # ✅ 成功标志：已登录

# 3. 立即扫描并增量上报一次（验证链路）
agentcli usage report                         # ✅ 成功标志：上报计数 > 0；--full 补报历史

# 4. 核对状态
agentcli status                               # daemon / worker 运行中
agentcli usage today                          # 今日本地用量摘要（不上传）
```

> ⚠️ 自动上报需要**三要素同时满足**：已登录 + 消息上报已开启 + 后台采集运行中。「消息上报」开关只在交互菜单或 Web 里（`agentcli` →「用量同步」→「消息上报」），没有单独子命令——这是刻意设计。

---

## CLI 命令速查

所有命令支持 `--json` 输出机器可读结果（适合 agent / 脚本调用）。不带参数运行 `agentcli` 进入终端导航。

### 启动与状态

| 命令                            | 说明                                                                                                                                                                                    |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentcli`                      | 打开终端导航（控制面菜单）：工作台、用量同步、用户、token 池(beta)                                                                                                                      |
| 菜单「工作台 → 开通数字员工」   | 快速创建数字员工并绑定飞书；仅支持 Claude Code / Codex。通过 lark-cli 为本次应用申请创建者的个人 `as user` 授权，并校验数字员工必需权限；成功后会静默尝试一次凭证上报（失败不影响创建） |
| `agentcli init`                 | 快速初始化：默认启动 Web 工作台 + 用量后台 worker（worker 默认开机自启）                                                                                                                |
| `agentcli web`                  | 直接启动 Web 工作台（默认 127.0.0.1:5680）；加 `--daemon` 后台运行                                                                                                                      |
| `agentcli --daemon --port 8080` | 后台运行并指定端口                                                                                                                                                                      |
| `agentcli status`               | 查看后台 daemon / Web 运行状态                                                                                                                                                          |
| `agentcli doctor`               | 只读本地诊断：配置、服务、路径                                                                                                                                                          |
| `agentcli stop`                 | 显示停止指引（不会主动关闭 Web / 用量 worker）                                                                                                                                          |
| `agentcli restart`              | 重启 Web daemon + 用量 worker（更新或改配置后用它让新代码生效；本地命令，免登录）                                                                                                       |

### 用户授权（上报前提）

| 命令                   | 说明                                          |
| :--------------------- | :-------------------------------------------- |
| `agentcli auth status` | 查看 AgentBus 用户授权状态                    |
| `agentcli auth login`  | 飞书授权登录 AgentBus；登录后用量才有上报目标 |
| `agentcli auth logout` | 退出 AgentBus 用户（不影响本地 runtime 登录） |

### 用量采集与上报

| 命令                                               | 说明                                                      |
| :------------------------------------------------- | :-------------------------------------------------------- |
| `agentcli usage status`                            | 后台 worker 是否运行、消息上报是否开启、上报运行时        |
| `agentcli usage today`                             | 查看今日本地 usage 摘要（不上传）                         |
| `agentcli usage start`                             | 开启轻量后台采集，默认配置开机自启；仅扫描本机 JSONL      |
| `agentcli usage stop`                              | 停止后台采集（默认关闭开机自启，`--keep-autostart` 保留） |
| `agentcli usage report`                            | 立即扫描并按服务端游标增量上报；`--full` 全量重扫补传历史 |
| `agentcli usage autostart status\|enable\|disable` | 管理开机自启（macOS launchd）                             |

### 团队 / 任务 / 维护

| 命令                             | 说明                                                                              |
| :------------------------------- | :-------------------------------------------------------------------------------- |
| `agentcli teams list`            | 列出本地团队（不启动 Web）                                                        |
| `agentcli teams create`          | 创建本地团队元数据；支持 `--name` / `--harness` / `--bind-project` / `--work-dir` |
| `agentcli tasks list --team <t>` | 查看某团队活跃任务                                                                |
| `agentcli update`                | 检查并自更新到最新版本                                                            |
| `agentcli add <plugin>`          | 安装能力插件到 MCP library（例：`add worker-society`）                            |

### 快速创建数字员工

在终端运行 `agentcli`，进入「**工作台 → 开通数字员工**」即可完成最小化快速开通：

1. 填写数字员工名称和描述，并选择 Claude Code 或 Codex；
2. 绑定飞书渠道；
3. 系统按当前已绑定飞书应用创建或复用 lark-cli profile（新 profile 固定为 `agentcli-user-<appId>`），并通过 `lark-cli` 为**创建者个人 `as user` 身份**请求 `--domain all`；
4. `--domain all` 只请求当前 lark-cli、飞书应用和租户允许授予的权限。CLI 必须用 `auth check` 校验文档、云盘、消息收发、通讯录与用户信息等数字员工必需权限；仅有 `contact:user.basic_profile:readonly` 不会通过；
5. CLI 会优先在终端显示授权二维码，并同时尝试打开默认浏览器；如果终端无法渲染二维码或浏览器未自动打开，仍会输出完整授权链接；
6. 授权校验成功后，AgentCli 会**静默**尝试一次将该应用的个人凭证上报到 AgentBus；上报失败不影响本地授权和数字员工创建，也不会在终端打印任何凭证；
7. 创建完成后返回团队与绑定状态。

若授权页完成后仍提示缺少权限，请先更新 `lark-cli`，再在飞书应用和租户后台启用/审批终端列出的缺失权限后重试。

快速创建只负责最小可用配置；成员、权限和高级参数可随后在 Web 工作台调整。

---

## ⚙️ 配置 AI 运行时（客户端配置）

### 本机数据来源

AgentCli 无侵入扫描本地会话日志：

| 运行时      | 数据位置                        | 采集内容                                 |
| :---------- | :------------------------------ | :--------------------------------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | token 用量、会话数、消息量；支持 IM 归因 |
| Codex       | `~/.codex/sessions/**/*.jsonl`  | token 用量（output_tokens 为主）         |

### 把网关 Key 写进 Claude / Codex（token 池认领）

登录后，在终端菜单 `agentcli` →「**token 池(测试版)**」→「**认领**」，会自动签发一个一次性网关 key。你可以选择写入 **Codex**、**Claude Code** 或两者；默认选择 Codex。认领后会直写本地运行时配置，并同步写入系统环境变量：

- **Claude Code** `~/.claude/settings.json`：写入网关 endpoint（`ANTHROPIC_BASE_URL`）+ `ANTHROPIC_AUTH_TOKEN`，deep-merge 保留其它键，**不固定模型**。
- **Codex** `~/.codex/auth.json`（`OPENAI_API_KEY`）+ `~/.codex/config.toml`（surgical 改写 `model_provider` / `model` / wire_api 与 `[model_providers.*]`，**保留 `[projects.*]`**）。Codex 的 base_url 由网关 `proxyPaths` 按所选 wire_api 解析，与 Claude 的 endpoint 不同。
- 同时写 `~/.hermit/aikey.env`（0600），作为已认领标记，并供外部 agent 手动 `source`。
- **系统环境变量**：认领时会一次性更新环境变量，不安装 `precmd` / `PROMPT_COMMAND` 等每次提示符执行的 hook：
  - **macOS**：更新 `~/.zshrc` 的 AgentCli 管理块，并通过 `launchctl setenv` 让当前登录会话中新启动的 GUI 应用可读取；已有终端请新开一个。
  - **Linux**：更新 `~/.bashrc` 的 AgentCli 管理块；新开终端后生效。
  - **Windows**：写入当前用户的 Windows 环境变量；新开终端后生效。
  - Claude Code 使用 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`；Codex 使用 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。只写入你在认领时选择的运行时对应变量。

> 🔒 首次写入前自动把你的**原始** Claude/Codex 配置快照到 `~/.hermit/agentcli.env.bak`（**只创建一次**，后续认领永不覆盖）。在「token 池 → **一键恢复原始配置**」可随时还原：原本存在的文件回到原内容，token 池新建的文件会被删除，无残留。检查快照时会自动修正旧版本遗留的备份路径记录，跨 1.9.8 / 1.9.9 升级后仍能准确恢复。认领到的 key 是**即焚明文**，不落库、不回显明文。该能力需服务端授权开通（部分账户暂未开放）。

---

## 默认路径与端口

| 项目             | 默认值                        | 说明                         |
| :--------------- | :---------------------------- | :--------------------------- |
| Web UI           | `http://127.0.0.1:5680/teams` | 团队工作台入口               |
| 本地状态         | `~/.hermit/`                  | 团队、任务、消息、设置、审计 |
| Claude Code 会话 | `~/.claude/projects`          | 用量和会话数据来源           |
| Codex 会话       | `~/.codex/sessions`           | Codex 用量数据来源           |

---

## 支持的 AI 运行时

| 一等适配                                         | 兼容注册                             |
| :----------------------------------------------- | :----------------------------------- |
| Claude Code, Codex, Gemini CLI, Cursor, OpenCode | Devin, Qoder, Kimi, iFlow, ACP, tmux |

---

## 架构

```text
开发者本地
  Claude Code / Codex / Cursor / Gemini / OpenCode ...
        ↓ 会话日志 & token 用量
  AgentCli  (本地 CLI + Web 工作台)
        ↓ 统一上报
  AgentBus (企业版 · 中心化数据总线)
        ↓ 看板 & 协作
  企业管理者 / 团队成员
```

| 组件                 | 是什么                                                                                                    | 怎么启动                                   |
| :------------------- | :-------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| **CLI** (`agentcli`) | 终端控制面。交互式导航菜单 + 全部子命令。                                                                 | `agentcli` 进菜单，或 `agentcli <command>` |
| **Web 工作台**       | 本地浏览器面板。团队、看板、运行时、用量、代码评审。                                                      | `agentcli web` / `agentcli --daemon`       |
| **Bus（团队总线）**  | 协调骨干。团队元数据、IM→团队路由、任务池、跨团队派发、审计、用量收敛。由独立商业项目 **agentbus** 提供。 | 企业版：`agentcli auth login` 接入         |

> CLI 和 Web 都是 Bus 的操作面——CLI 适合命令行与自动化，Web 适合可视化；两者读写同一份本地数据。

---

## 截图

<details>
<summary>展开查看更多截图</summary>

<table>
  <tr>
    <td align="center"><b>团队列表</b></td>
    <td align="center"><b>团队工作区</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agentcli/team-list.png" alt="Team list" width="480" /></td>
    <td><img src="docs/screenshots/agentcli/team-detail.png" alt="Team detail" width="480" /></td>
  </tr>
  <tr>
    <td align="center"><b>任务看板</b></td>
    <td align="center"><b>运行时设置</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agentcli/tasks.png" alt="Task board" width="480" /></td>
    <td><img src="docs/screenshots/agentcli/settings.png" alt="Settings" width="480" /></td>
  </tr>
</table>

</details>

---

## 更新 AgentCli

> **1.9.34+ 起**：更新会顺带修复 cc-connect 二进制下载问题（国内 / 企业防火墙环境下原本会静默失败，导致「同步到运行时失败：fetch failed」）。cc-connect 安装走镜像、启动时自愈下载，无需手动处理。遇到 fetch failed 的用户升级到最新版即可。

更新前先停止会加载全局安装目录文件的进程，避免 Windows `EBUSY`，也避免旧 worker 在更新后继续运行旧代码：

```bash
# 1. 停用量 worker
agentcli usage stop

# 2. 停 Web daemon；它托管的 cc-connect / hermit-bridge 也会随之退出
agentcli services stop web

# 3. 安装最新版
npm install -g @yancyyu/agentcli@latest --prefer-online

# 4. 恢复 Web + 用量 worker
agentcli init

# 5. 验证
agentcli --version
agentcli status
agentcli usage status
agentcli doctor
```

注意：

- 裸 `agentcli stop` **只显示停止指引**，不会停止 Web daemon 或用量 worker。
- 协作服务是配置项，不是独立本地进程，无需为了更新单独停止。
- `agentcli update` 是内置自更新：**免登录**（本地生命周期命令），且固定走官方 `registry.npmjs.org`——避免默认镜像（如 npmmirror）同步延迟导致装到旧版或 `ETARGET`。它会在成功后热重载用量 worker，但**不重启 Web daemon**；更新后跑一次 `agentcli restart` 让 Web daemon / hermit-bridge / cc-connect 也切到新代码。Windows 若遇到文件锁，使用上面的完整手动流程。
- 停止服务和更新包不会删除 `~/.hermit/` 中的团队、渠道配置、登录态或用量状态。
- 若仍提示文件被占用，只终止与 agentcli / hermit / cc-connect 明确相关的残留进程，不要批量结束所有 Node 进程。

完整说明见 [在线指南 · 安全更新 AgentCli](https://yancyuu.github.io/agentcli/#update)。

---

## 常见问题

<details>
<summary><b>「同步到运行时失败：fetch failed」/ cc-connect 未就绪</b></summary>

这是 cc-connect（hermit-bridge 的底层运行时）的二进制没装上造成的。cc-connect 的二进制会从 GitHub Releases 下载，国内 / 企业防火墙环境下经常失败，而它又是可选依赖，npm 会静默跳过，导致工作台能开但团队配置、消息收发全不可用。

**1.9.34+ 已内置自动修复**：安装时走镜像、启动时自愈下载、顶部横幅提示。

升级到最新版即可自动解决：

```bash
agentcli services stop web
npm install -g @yancyyu/agentcli@latest --prefer-online
agentcli services start web
```

升级后重开工作台，cc-connect 会自动从镜像（`gh-proxy.com` / `ghproxy.net`）下载到 `~/.hermit/cc-connect-bin/`。

**临时手动修复**（无法升级时）：

```bash
# 1. 看端口有没有监听（9820 / 9810）
netstat -ano | findstr "9820 9810"   # Windows
lsof -i :9820                        # macOS

# 2. 直接装 cc-connect，走镜像
npm install -g cc-connect
# 或强制指定镜像前缀
CC_CONNECT_MIRROR=https://gh-proxy.com/ npm install -g cc-connect
```

也可设置环境变量让后续安装都用镜像：

```bash
export CC_CONNECT_MIRROR=https://gh-proxy.com/   # 加到 ~/.zshrc 或系统环境变量
```

</details>

<details>
<summary><b>EBUSY: resource busy or locked（Windows 安装 / 更新）</b></summary>

不是权限问题（EBUSY ≠ EACCES），`sudo` / 管理员身份无效。是之前运行过的 agentcli 后台进程还占着包内文件，npm 无法替换。先关掉再装：

```bash
agentcli services stop web
agentcli usage stop
npm install -g @yancyyu/agentcli@latest --prefer-online
```

`agentcli stop` 只显示停止指引，不会主动关闭 Web / 用量 worker。

还不行就杀掉残留 node 进程（只杀 agentcli / hermit 相关），或直接重启电脑后重装。

</details>

<details>
<summary><b>EACCES: permission denied（权限报错）</b></summary>

之前用 `sudo` 运行过，部分文件被 root 占有：

```bash
sudo chown $(whoami) ~/.hermit/telemetry/worker.pid
sudo chown -R $(whoami) ~/.npm-global   # npm global 目录也报错时
```

预防：不要用 `sudo` 运行 `agentcli` 或 `npm install -g`。

</details>

<details>
<summary><b>agentcli 命令找不到</b></summary>

npm 全局 bin 目录不在 PATH。添加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

</details>

<details>
<summary><b>会上传代码或消息内容吗？</b></summary>

默认 **metadata-only**：不上传消息正文、助手回复、工具输入输出、cron prompt 或密钥。只上报 token 数、时间戳、维度。具体上报范围取决于 AgentBus 管理员配置。

</details>

<details>
<summary><b>AgentCli 和 AgentBus 是什么关系？收费吗？</b></summary>

**AgentCli** 是本地 CLI + Web 工作台，单机完整可用。**AgentBus** 提供团队协作、企业用量看板、IM 路由、跨团队派发、审计等能力。不接 Bus 不影响本地使用。

</details>

---

## 文档

- [在线指南](https://yancyuu.github.io/agentcli/)（安装、命令、配置、FAQ）
- [Changelog](docs/CHANGELOG.md)

---

## License

[AGPL-3.0](LICENSE)

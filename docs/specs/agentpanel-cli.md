# AgentPanel CLI — Product Spec

## 1. 一句话定位

AgentPanel 是面向本地 AI runtime 的工作区，管理团队任务、消息、频道和可审计的派发状态。

> Web UI 是人看的控制面，CLI 是 agent / operator 使用的入口。

CLI 不是新的独立产品，也不是突然新增的一条线。它是 AgentPanel 同一个本地工作区的第二个入口：人通过 Web UI 看和管，agent / operator 通过 CLI 查询状态、上报事实、触发常用操作。

## 2. 为什么 CLI 不突兀

AgentPanel 当前已经在做几件事：

- 管理本地 AI runtime：Claude Code、Codex、Gemini、Cursor、OpenCode、bridge runtime。
- 组织团队工作区：team、task、message、project workspace。
- 保存本地状态：默认 `~/.hermit/`。
- 处理渠道路由和 allowlist。
- 投影跨团队 dispatch、交付、审核和审计状态。

这些能力目前主要通过 Web UI 暴露给人。但 agent 也需要操作同一套状态，例如：

- 查询当前本机用量是否已上报。
- 查询团队 / 任务 / runtime 状态。
- 创建任务或发送消息。
- 触发诊断、巡检、汇总、上报。

所以 CLI 的自然定位是：

> 把 Web UI 里人能看的 AgentPanel 状态，逐步变成 agent / operator 可以稳定调用的命令。

这不是改变产品方向，而是补齐使用者入口。

## 3. 产品分层

| 层 | 面向谁 | 职责 | 不负责 |
|---|---|---|---|
| Web UI | 人 | 查看和操作团队、任务、消息、频道、用量、审核、运行时状态 | 给 agent 提供稳定命令接口 |
| AgentPanel CLI | agent / operator | 查询状态、上报事实、触发常用操作、输出机器可读结果 | 替代 Web UI 的完整交互 |
| AgentPanel API / storage | 系统 | 本地状态、团队工作区、跨团队 dispatch、审计投影 | 执行模型推理 |
| hermit-bridge | runtime / channel adapter | runtime 生命周期、渠道接入、Bridge 消息投递、project 配置 | AgentPanel 业务状态和跨团队决策 |
| AI runtimes | Claude Code / Codex / Gemini / Cursor / OpenCode 等 | 实际执行任务、工具调用、内部计划和局部重试 | 全局团队路由、审计和跨团队协议 |

## 4. 两个入口

AgentPanel 暴露同一个本地工作区，但有两个入口：

| 入口 | 面向谁 | 典型使用 |
|---|---|---|
| Web UI | 人 | 看团队、看任务、看消息、配置频道、审核结果、观察运行状态 |
| CLI | agent / operator | 查状态、上报 usage、执行诊断、触发常用操作、输出 JSON 给自动化流程 |

推荐 README 叙事：

```text
Web UI for humans. CLI for agents and operators.
```

中文：

```text
Web UI 给人看，CLI 给 agent 和 operator 用。
```

## 5. CLI 总目标

长期目标：让 AgentPanel 的高频能力具备 agent-friendly CLI。

原则：

1. 先读后写。
2. 每个命令都必须有明确对象和幂等语义。
3. 默认输出人类可读文本。
4. 支持 `--json` 输出机器可读结果。
5. 不隐式启动 Web UI。
6. 不复制 Web UI 的所有交互细节。
7. 写操作必须避免模糊副作用。

## 6. 第一阶段：CLI foundation + 只读工作区投影

第一阶段不能只做 usage。usage 是重要纵切，但如果 CLI 一上来只会上报用量，会显得像临时外挂；按 AgentPanel 的定位，agent/operator 首先需要稳定地回答：本机 AgentPanel 在不在、状态是否健康、有哪些团队、当前任务是什么。

所以第一阶段先建立 CLI 基座：

- 不启动 Web UI 的命令分发。
- 默认文本输出，`--json` 输出机器可读结果。
- 只读诊断和本地工作区查询。
- 为 usage/report 复用同一套输出与 no-Web 入口。

第一阶段命令：

```bash
hermit status --json
hermit doctor --json
hermit teams list --json
hermit tasks list --team <team> --json
```

usage 作为紧随其后的第二个纵切：

```bash
hermit usage today
hermit usage status
hermit usage report
hermit usage start
```

等价入口：

```bash
agentpanel teams list --json
agentpanel usage today
```

## 7. 命令行为

### 7.1 `hermit usage today`

只读查看本机今天 Claude Code usage。

要求：

- 扫描本机 Claude Code JSONL。
- 只统计当天 sessions / messages / tokens。
- 不上传。
- 不写 queue。
- 不启动 Web UI。
- 支持 `--json`。

示例：

```text
AgentPanel usage today

Date: 2026-06-21
Sessions: 12
Messages: 184
Tokens: 1,234,567
  input: 123,456
  output: 78,900
  cache read: 987,654
  cache creation: 44,557
```

### 7.2 `hermit usage status`

查看本地 usage 上报状态。

要求：

- 读取 `~/.hermit/session-index/state.json`。
- 读取 `~/.hermit/settings.json` 中的 telemetry / task bus 配置。
- 输出最近 scan / report / upload 时间。
- 输出 pending / sent / duplicate 等计数。
- 输出 upload gate 状态和 disabled reason。
- 不上传。
- 不启动 Web UI。

典型 disabled reason：

```text
missing-settings
missing-task-bus
bus-disabled
telemetry-disabled
upload-disabled
redis-missing
ready
```

### 7.3 `hermit usage report`

一次性扫描并准备 metadata-only usage events，然后按配置尝试上报。

要求：

- 复用已有 JSONL scanner。
- 转成隐私安全 payload。
- 本地去重。
- 上传关闭时不失败，输出 disabled reason。
- 上传失败时保留 pending queue。
- 上传成功时标记 sent。
- 不启动 Web UI。

示例：

```text
AgentPanel usage report

Scanned sessions: 182
Prepared events: 28
Uploaded: 28
Duplicate: 154
Pending: 0
Privacy: metadata-only, no prompts or paths uploaded
```

上传关闭时：

```text
AgentPanel usage report

Scanned sessions: 182
Prepared events: 28
Uploaded: 0
Pending: 28
Upload: disabled (telemetry-disabled)
Privacy: metadata-only, no prompts or paths uploaded
```

### 7.4 `hermit usage start`

无 Web 的 headless usage 上报循环。

要求：

- 不启动 Web UI。
- 默认每 10 分钟执行一次 report。
- 支持 `--interval 5m|10m|1h`。
- 支持 SIGINT / SIGTERM 优雅退出。
- 每轮打印简短结果。

示例：

```bash
hermit usage start --interval 10m
```

## 8. 隐私边界

usage CLI 的核心卖点之一是“本机可验证、metadata-only”。

允许上传：

- hash 后的 session id / source id。
- hash 后的 project id。
- token 数。
- message 数。
- start / end / updated timestamp。
- runtime 类型。
- app / CLI version。
- schema version。

禁止上传：

- prompt 文本。
- assistant response 文本。
- prompt-derived `SessionEntry.title`。
- 原始 JSONL。
- `relPath`。
- `projectPath`。
- 绝对路径。
- shell command。
- tool input / tool args。
- 图片 / 截图内容。

任何新增字段都必须经过 allowlist，而不是 blacklist。

## 9. 本地状态

第一阶段使用简单文件，不引入 SQLite：

```text
~/.hermit/session-index/
  state.json
  queue.jsonl
  upload.log
```

`state.json` 存：

- schemaVersion
- lastScanAt
- lastReportAt
- lastUploadedAt
- lastError
- scannedSessions
- preparedEvents
- uploadedEvents
- duplicateEvents
- pendingEvents

`queue.jsonl` 每行一个 metadata-only event。

第一阶段去重 key：

```text
sessionIdHash + updatedAt + totalTokens
```

后续如果能稳定拿到 turn-level id，再升级为 turn-level 去重。

## 10. 配置与上传 gate

复用现有：

```text
~/.hermit/settings.json
```

读取：

```json
{
  "taskBus": {
    "enabled": true,
    "redis": {
      "host": "127.0.0.1",
      "port": 6379
    },
    "telemetry": {
      "enabled": true,
      "uploadEnabled": true,
      "platform": "claudecode"
    }
  }
}
```

新增中性 gate：

```text
src/main/utils/usageUploadGate.ts
```

不要复用 `imUsageGate.ts` 的命名。IM usage 和本地 Claude Code usage 是不同上报面。

启用条件：

```text
taskBus.enabled === true
AND taskBus.telemetry.enabled === true
AND taskBus.telemetry.uploadEnabled !== false
AND redis config exists
```

## 11. 实现结构

推荐文件：

```text
bin/agentpanel.mjs
src/main/cli/usageCli.ts
src/main/cli/cliOutput.ts
src/main/services/session-intelligence/LocalClaudeCodeUsageReporter.ts
src/main/services/session-intelligence/LocalUsageReportTypes.ts
src/main/services/session-intelligence/LocalUsagePrivacy.ts
src/main/utils/usageUploadGate.ts
```

分工：

- `bin/agentpanel.mjs`：只做命令分发，在 Web/server 启动前拦截 `usage`。
- `usageCli.ts`：parse args，调用 service，打印文本或 JSON。
- `LocalClaudeCodeUsageReporter.ts`：scan / queue / upload。
- `LocalUsagePrivacy.ts`：hash 和 payload allowlist。
- `usageUploadGate.ts`：纯函数判断上传是否启用。

## 12. 测试

新增测试：

```text
test/main/services/session-intelligence/LocalUsagePrivacy.test.ts
test/main/services/session-intelligence/LocalClaudeCodeUsageReporter.test.ts
test/main/utils/usageUploadGate.test.ts
```

覆盖：

- payload 不包含 prompt / response / title / path / tool args。
- id 被 hash。
- disabled reason 准确。
- `uploadEnabled` 缺省时按开启处理。
- queue 去重。
- upload disabled 不失败。
- upload failure 保留 pending。

CLI smoke：

```bash
node bin/agentpanel.mjs usage today
node bin/agentpanel.mjs usage status
node bin/agentpanel.mjs usage report
node bin/agentpanel.mjs usage today --json
```

质量门：

```bash
pnpm exec vitest run LocalUsagePrivacy LocalClaudeCodeUsageReporter usageUploadGate 2>&1 | tail -20
pnpm typecheck 2>&1 | tail -20
```

## 13. 后续 CLI 扩展

usage 跑通后，再逐步扩展：

```text
hermit teams list
hermit teams show <team>
hermit tasks list --team <team>
hermit tasks create --team <team> --title ...
hermit messages send --team <team> --text ...
hermit runtime status
hermit config get/set
hermit doctor
```

扩展顺序建议：

1. status / list / show 类只读命令。
2. report / doctor 类事实输出命令。
3. create / send 类明确写入命令。
4. start / stop / restart 类运行时命令。

## 14. README 定位建议

README 顶部应该先讲主定位，再自然带出 CLI。

推荐英文：

```html
<p align="center">
  <strong>Local-first workspace for AI runtimes and team task routing.</strong><br/>
  Manage local Claude Code, Codex, Gemini, Cursor, OpenCode, and bridge runtimes through teams, tasks, messages, channels, and auditable dispatch state.<br/>
  Web UI for humans. CLI for agents and operators.
</p>
```

推荐中文：

```html
<p align="center">
  <strong>面向本地 AI runtime 的工作区与团队任务路由层。</strong><br/>
  通过团队、任务、消息、频道和可审计的派发状态，管理本机 Claude Code、Codex、Gemini、Cursor、OpenCode 以及 bridge runtime。<br/>
  Web UI 给人看，CLI 给 agent 和 operator 用。
</p>
```

语言切换放在标题附近：

```html
<p align="center">
  <a href="./README.md"><strong>English</strong></a> ·
  <a href="./README-CN.md"><strong>简体中文</strong></a>
</p>
```

避免继续使用：

```text
Local-first control plane for AI agent teams.
```

这个说法太泛，容易让用户误以为 AgentPanel 自己是完整 agent 团队控制平台。

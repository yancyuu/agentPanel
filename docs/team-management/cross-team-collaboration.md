# Cross-Team Collaboration Workflow

本文说明当前跨团队消息和跨团队派单的真实路径，并标出 Task Bus 目标模型边界。

## 核心原则

跨团队协作不是普通通知系统。正式派单必须有状态、事实源和审计记录。

当前实现分两条路径：

1. **轻量跨团队消息**：把一条消息同步到另一个团队的 message workspace。
2. **正式 Task Bus dispatch**：通过 Redis-backed dispatch 创建跨团队任务请求，并进入接受、拒绝、交付、审批、修订生命周期。

不要把两者混在一起。普通消息不代表对方团队已接单；dispatch 失败也不应静默退化为普通消息。

## 当前产品边界

- 后端是 Fastify API，跨团队入口集中在 `/api/cross-team/*`。
- 团队数据默认落在 `~/.hermit/` 的 team/task/message workspace。
- cc-connect 负责 runtime 和渠道 Bridge，不负责跨团队任务状态机。
- 正式派单依赖 Redis task bus 配置。
- 当前没有 Electron IPC inbox 作为主路径，也没有内嵌 PTY。

## 路径一：轻量跨团队消息

用途：同步沟通内容、引用上下文、提醒另一个团队。

当前链路：

1. Renderer composer 序列化文本、chips 和 `taskRefs`。
2. Messages panel 调用 team store 的 cross-team send action。
3. Store 调用 HTTP `/api/cross-team/send`。
4. Fastify server 的 text 分支写入发送方 `cross_team_sent` 和目标团队 `cross_team` 消息。
5. `TeamWorkspaceService.appendMessage()` 落盘到团队 message workspace。
6. UI 订阅变更并刷新消息流。

`taskRefs` 来自结构化 task mention。它们用于渲染可点击 task 链接，不等于创建 dispatch。

## 路径二：正式 Task Bus dispatch

用途：创建真正的跨团队任务请求，让目标团队进入生命周期。

当前链路：

1. 用户或 Agent 在消息输入中发起面向团队的 subject 请求，或调用跨团队派单入口。
2. Fastify `/api/teams/:name/send-message` 或 `/api/cross-team/send` 进入 dispatch / task projection 逻辑。
3. 系统只在目标团队创建 TODO 任务，并写入 `dispatchMeta.status = "received"`。
4. 创建阶段不会发送 runtime 执行消息；目标团队必须在自己的 TODO 中点击「启动」。
5. 点击「启动」后，任务进入执行中，`dispatchMeta.status = "in_progress"`，此时才发送给目标团队 runtime。
6. 目标团队完成后，任务进入 done，`dispatchMeta.status = "completed"`，并通知派发方。

跨实例目标团队仍依赖 Redis task bus 来创建目标侧 TODO 投影；本地团队之间不应因为 Redis 未配置而绕过「TODO → 启动 → 执行」流程。

## 当前状态机

```text
received
  └─ target user clicks 启动 → in_progress → completed/approved

legacy pending_accept
  ├─ start/accept → in_progress
  ├─ reject       → rejected
  └─ timeout/fail → failed
```

说明：

- `received`：任务已经进入目标团队 TODO，等待目标团队用户点击「启动」。
- `pending_accept`：旧状态兼容，UI 也按「待启动」处理。
- `in_progress`：目标团队已点击「启动」，runtime 才开始执行。
- `completed` / `approved`：目标团队已完成，并同步/通知派发方。
- `rejected`：目标团队拒绝。
- `failed`：派单或流转失败。

## API 入口

当前主要接口：

```text
GET  /api/cross-team/targets
POST /api/cross-team/send
POST /api/cross-team/accept
POST /api/cross-team/reject
POST /api/cross-team/deliver
POST /api/cross-team/approve
POST /api/cross-team/revision
GET  /api/settings/task-bus
POST /api/settings/task-bus
```

示例请求只说明字段形态，实际返回以当前 Fastify handler 为准。

### 发现团队

```http
GET /api/cross-team/targets?excludeTeam=prd
```

返回本地和 Redis 上可用团队，排除自身。

### 派发任务

```http
POST /api/cross-team/send
Content-Type: application/json

{
  "fromTeam": "prd",
  "toTeam": "hermit",
  "subject": "修改 API 返回格式",
  "description": "需要修改 /api/users 的分页字段",
  "deadlineMinutes": 120,
  "needsHumanReview": true
}
```

成功后通常会：

- 在派发方形成外部派单投影。
- 在目标团队形成待接单任务/消息投影。
- 写入 Redis task bus。
- 触发 UI 刷新和可用通知。

### 接受任务

```http
POST /api/cross-team/accept
Content-Type: application/json

{
  "team_slug": "hermit",
  "dispatch_id": "dispatch-id"
}
```

### 拒绝任务

```http
POST /api/cross-team/reject
Content-Type: application/json

{
  "team_slug": "hermit",
  "dispatch_id": "dispatch-id",
  "reason": "当前团队没有仓库访问权限"
}
```

### 交付结果

```http
POST /api/cross-team/deliver
Content-Type: application/json

{
  "team_slug": "hermit",
  "dispatch_id": "dispatch-id",
  "result": "已完成，修改了 3 个文件"
}
```

### 审批通过

```http
POST /api/cross-team/approve
Content-Type: application/json

{
  "team_slug": "prd",
  "dispatch_id": "dispatch-id"
}
```

### 要求修订

```http
POST /api/cross-team/revision
Content-Type: application/json

{
  "team_slug": "prd",
  "dispatch_id": "dispatch-id",
  "feedback": "返回格式还缺少分页信息"
}
```

## UI 投影

跨团队协作在 UI 中是投影，不是独立事实源。

派发方看到：

- 目标团队
- 当前状态
- 是否已接单
- 交付摘要
- 审批 / 退回按钮

接收方看到：

- 来源团队
- 待接单任务
- 执行中任务
- 待重新提交任务
- 交付入口

消息流里出现的跨团队消息只代表沟通记录。正式派单状态以 dispatch metadata 和 task bus 状态为准。

## Redis Task Bus 配置

正式跨团队派单需要 Redis task bus：

1. 在设置中配置 Redis 连接。
2. 开启分布式团队协作能力。
3. 多个 openHermit 实例连接同一个 Redis 时，才能跨实例发现和派单。

Redis 用于 dispatch 请求、响应和团队发现。它不是聊天渠道，也不是团队内部 todo 存储。

## cc-connect 与渠道关系

外部平台消息先进入 cc-connect，再由 Hermit 根据 session key 和团队白名单路由到 team message workspace。

渠道消息可以触发团队工作，但渠道本身不等于 Task Bus：

| 场景 | 当前归属 |
|:---|:---|
| Feishu/Lark、微信、Slack 等消息进入团队 | cc-connect + Hermit channel routing |
| 团队 A 给团队 B 发普通消息 | cross-team message |
| 团队 A 要求团队 B 接单并交付 | Redis-backed dispatch |
| offer / bid / lease / event 完整协议 | 目标 Task Bus |

## 目标模型：CollabTask + Event Log

下面是目标设计，不代表当前全部实现。

目标事实源：

```text
CollabTaskStore
  ↓
TaskEventLog
  ↓
Outbox / Projection
  ↓
Redis / Inbox / Channel / UI
```

目标底线：

1. 状态只由 command 触发。
2. 状态变化必须写 event log。
3. 通知通过 outbox 异步投递，可重试。
4. Agent 以 pull/ack 方式读取 inbox，不被异步消息强行打断。
5. 大文件、日志、截图、patch 只走 artifact ref，不进 Redis/inbox/context。

目标对象：

```typescript
interface CollabTask {
  dispatchId: string;
  subject: string;
  description?: string;
  fromTeam: string;
  toTeam: string;
  status: CollabTaskStatus;
  version: number;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}
```

目标状态机会扩展为 `pending_accept`、`accepted`、`in_progress`、`delivered`、`revision_requested`、`approved`、`rejected`、`timeout_cancelled`、`review_timeout`、`escalated`、`failed`、`cancelled`。

## 排查顺序

排查跨团队问题时按以下顺序确认：

1. 这是普通跨团队消息，还是正式 dispatch。
2. Redis task bus 是否配置并可连接。
3. `/api/cross-team/*` 请求是否成功。
4. `TaskDispatchService` 是否写入 dispatch metadata。
5. 目标团队 message/task projection 是否落盘。
6. UI 是否收到刷新事件。
7. 如果涉及外部平台，再检查 cc-connect session key、团队绑定和白名单。

旧文档中提到的 `TeamInboxReader` / IPC inbox 路径不是当前跨团队任务主入口。

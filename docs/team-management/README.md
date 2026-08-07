# Team Management Architecture

本文是团队、渠道和跨团队任务的 canonical 入口。若历史 research / plan 文档与本文冲突，以当前代码和本文为准。

## 当前结论

AgentPanel 不是团队内部 Leader/Member 模拟器。更稳定的模型是：

> AgentPanel 是本地优先的团队工作区和跨团队任务协议层。

团队内部如何计划、执行、重试、review，由各自 runtime 和工作流决定。AgentPanel 负责团队配置、任务/消息工作区、渠道路由、跨团队状态机、审计和用户可见控制面。

## 当前产品边界

| 项 | 当前事实 |
|:---|:---|
| 产品形态 | Fastify API + Vite Web UI |
| 默认入口 | `/teams` |
| 默认数据目录 | `~/.hermit/` |
| 包名 | `@yancyyu/agentpanel` v1.6.42 |
| Bridge | hermit-bridge / Management API |
| 工作区 | team、task、message、project workspace |
| 隔离 | 成员可使用独立 worktree |
| 跨团队 | Redis-backed dispatch 是当前实现；完整 Task Bus 是目标模型 |
| 不包含 | 当前没有 Electron 桌面打包；没有内嵌 PTY |

## 架构分工

| 层级 | 负责 | 不负责 |
|:---|:---|:---|
| AgentPanel | 团队列表、团队配置、任务看板、消息工作区、渠道绑定、白名单、审计、跨团队 dispatch、Task Bus 目标协议 | 平台 Bot 适配、模型能力、团队内部 todo 细节 |
| Team runtime | 执行任务、内部计划、工具调用、局部重试、局部 review | 全局路由、跨团队审计、其他团队状态管理 |
| hermit-bridge | runtime 生命周期、渠道接入、Bridge 消息投递、project 配置 | AgentPanel 业务状态、跨团队任务决策 |
| Redis Task Bus | 当前跨团队派单和响应流转 | 用户聊天渠道、团队内部任务存储 |

## 团队工作区

每个团队围绕四类数据组织：

```text
team
  ├─ members / runtime config
  ├─ tasks
  ├─ messages
  └─ project workspace / worktree
```

- **team**：团队 slug、名称、成员、harness、runtime 配置、渠道绑定。
- **tasks**：团队看板任务、外部派单投影、交付和审核状态。
- **messages**：团队消息、跨团队消息、hermit-bridge 事件、渠道消息。
- **workspace**：项目目录和可选 worktree 隔离。

AgentPanel 只持久化控制面和投影状态，不把 runtime 内部思考、工具调用或私有 todo 强行改造成统一格式。

## hermit-bridge 与渠道边界

外部平台接入由 hermit-bridge 承载。AgentPanel 不直接实现 Feishu/Lark、微信、Telegram、Discord、Slack 等平台 Bot 适配器。

当前分层：

1. **平台绑定**：团队绑定弹窗把平台凭据交给 hermit-bridge。Feishu/Lark 和微信支持扫码授权；其它平台通过 token、secret、bot id 等表单配置。
2. **团队路由**：AgentPanel 根据 hermit-bridge 传入的外部 `session_key` 匹配团队。当前主要覆盖 Feishu/Lark、微信、Telegram、Discord、Slack 的 session key 解析。
3. **访问控制**：团队配置里的 `platformAllowChat` / `platformAllowFrom` 用平台维度限制群聊、频道或用户，支持逗号/空白分隔列表和 `*`。
4. **审计归档**：渠道消息进入团队 message workspace，不能映射到团队的外部 session 不应写成伪团队目录。

渠道不是 Task Bus。渠道解决“谁能触达团队”；Task Bus 解决“团队之间如何派单、验收和审计”。

## Worktree 隔离

团队创建、启动或添加成员时，可以让成员使用独立 worktree。

用途：

- 降低多成员并行修改同一仓库的冲突。
- 让每个成员拥有可追踪的工作目录。
- 支持按任务或成员隔离变更，再由用户审查合并。

边界：

- Worktree 是代码工作区隔离，不是安全沙箱。
- 是否创建、命名和清理 worktree 由团队配置和 runtime 流程决定。
- 文档不要把它描述成容器隔离或远程执行环境。

## 当前跨团队实现：Redis-backed dispatch

当前跨团队任务以 dispatch-first 实现为主。

当前能力：

- 发现本地和 Redis 上的可用团队。
- 从一个团队向另一个团队派发任务。
- 目标团队接受或拒绝。
- 接受后创建本地任务/消息投影。
- 接收方交付结果。
- 派发方审批通过或要求修订。

当前接口集中在：

```text
/api/cross-team/*
/api/settings/task-bus
```

当前服务重点：

| 模块 | 职责 |
|:---|:---|
| `TeamWorkspaceService` | 本地 team/task/message workspace 存储 |
| `TaskDispatchService` | Redis 团队发现、派单、接受/拒绝、交付、审批、修订 |
| `HermitBridge` | runtime / Channel Bridge，不承载 Task Bus 决策 |
| `externalPlatformSessionRouting` | 外部 session key 到团队的路由和白名单判断 |
| `src/shared/types/team.ts` | dispatch、task bus config、团队渠道白名单类型 |

未配置 Redis task bus 时，正式跨团队派单会失败并提示需要配置，不会自动退化成普通消息。

## 目标模型：Task Bus

完整 Task Bus 是后续目标，不是当前全部可用能力。

目标 Task Bus 记录跨团队协作事实，而不是团队内部 todo：

- 谁发起任务。
- 任务需要什么能力。
- 哪些团队可以做。
- 谁获得临时协调权。
- 过程发生哪些事件。
- 最终结果是什么。

目标核心对象：

| 对象 | 说明 |
|:---|:---|
| Task Offer | 进入总线的任务请求 |
| Task Bid | 团队对任务的能力、计划、成本和风险声明 |
| Coordinator Lease | 某个任务上的临时协调权，不是固定 Leader |
| Task Event Log | 看板、报告和审计的事实源 |

目标 API 草案：

```text
POST /api/task-bus/offers
GET  /api/task-bus/tasks/:taskId
GET  /api/task-bus/tasks/:taskId/events
POST /api/task-bus/tasks/:taskId/bids
POST /api/task-bus/tasks/:taskId/select
POST /api/task-bus/tasks/:taskId/lease/renew
POST /api/task-bus/tasks/:taskId/events
POST /api/task-bus/tasks/:taskId/review
POST /api/task-bus/tasks/:taskId/complete
POST /api/task-bus/tasks/:taskId/fail
```

这些 API 是演进方向。当前公开跨团队接口仍以 `/api/cross-team/*` 和 `/api/settings/task-bus` 为主。

## 目标状态机

```text
created
  → offered
  → claimed
  → planning
  → running
  → waiting_on_dependency
  → running
  → review_requested
  → completed

running → failed → offered | escalated
created/offered/claimed → cancelled
```

状态只描述跨团队协议，不替代团队内部计划。

## 后续演进顺序

1. 保持当前 Redis dispatch 稳定。
2. 把 dispatch 事件沉淀为统一 event log。
3. 补齐本地 Task Bus repository。
4. 新增 `TaskBusService` 管理 offer、bid、lease、event。
5. 新增 `/api/task-bus/*` 给 UI 和手动测试。
6. 把当前 dispatch 逐步映射到 Task Offer / Event。
7. 在 UI 展示 lease、事件时间线和 review 结果。

## 历史文档

本目录下的 research 和 plan 文档保留为历史研究材料：

- `research-messaging.md`
- `research-inbox.md`
- `research-tasks.md`
- `research-worktrees.md`
- `research-cli-orchestration.md`
- `opencode-native-semantic-messaging-plan.md`
- `task-queue-derived-agenda-plan.md`

这些文档可能包含 Electron 桌面时代、旧 Leader/Member 假设或 pre-hermit-bridge 路由描述。新实现以当前代码和本文为准。

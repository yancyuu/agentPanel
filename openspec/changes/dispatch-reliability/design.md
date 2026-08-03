# Design: 派发可靠性

## Context

现状：`teamTaskRoutes.ts:683` needsFix 分支一律只记条目不派发；`dispatchTask` fire-and-forget（无送达确认）；真实事故（proposal）。会话存活性可查：`DirectCliSessionManager` 的会话表 + `featureState` 的 pid/心跳判活模式；agent 活动可查：任务线程消息（group.jsonl 按 conversationId）。

## Goals / Non-Goals

**Goals**：needsFix 无活动时新反馈触发重派；派发失败可见（等待上线态）；上线自动补发。
**Non-Goals**：不建持久化派发队列（v1 用 lastDispatchAt + 触发点补发，不后台巡检）；不改变 revisionCount 语义；不做跨团队 dispatch（未实现域）。

## Decisions

### D1：活动判定 = 线程 agent 消息或会话存活，取 OR

`hasAgentActivitySinceNeedsFix(task)`：任务线程（conversationId=`task:<id>`）中 exists agent/source!=user 消息且时间 > 最新 review_changes_requested 事件时间；或该团队执行会话当前存活。实现放 TeamWorkspaceService 或路由侧 helper，复用 readMessages。

### D2：等待态不引入新 status，用 waitingForAgent 布尔 + lastDispatchAt

Task 增加 `waitingForAgent?: boolean`、`lastDispatchAt?: string`。dispatchTask 返回 { delivered: boolean }：不可达时路由置 waitingForAgent=true + lastDispatchAt，UI 状态映射优先级最高显示「等待智能体上线」（amber，区别于进行中 orange）；可达时清除。不新加 status 枚举，避免状态机膨胀（宪法：概念非留不可）。

### D3：补发触发点 = 会话建立钩子 + 用户操作路径

DirectCliSessionManager spawnSession 成功后回调（或 teamRuntimeRoutes 会话建立处）检查该团队 waitingForAgent 任务并补发；start/request_changes 路径本身也做「waiting 则先尝试派发」。不做定时巡检。

## Risks / Trade-offs

- [活动判定误判（agent 在其他线程活动）] → 只看本任务线程 + 本团队会话存活，误判只会导致多派一次，agent 幂等可承受。
- [等待态与既有状态 chip 映射冲突] → 映射表加最高优先级分支，测试锁定。

## Migration Plan

无迁移：旧任务无 waitingForAgent 字段视为 false。回滚=移除分支。

## Open Questions

- 无。

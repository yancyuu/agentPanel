# Proposal: 任务派发可靠性

## Why

返工/任务派发是"发消息即忘"：agent 会话不在线时指令蒸发，任务永远停在「进行中」而无人干活。且 needsFix 去重分支（同一轮退回不重复派发）与此叠加后，后续反馈永远不会再触发派发——真实案例：演示任务第一次返工派发蒸发后，用户连续 3 条反馈全部只进列表，任务卡死两天。

## What Changes

- **needsFix 再派发条件化**：needsFix 态下收到新反馈时，若自进入 needsFix 以来该任务**没有任何 agent 活动**（无 agent 消息、无会话存活），则重新派发返工（携带全部 open 反馈），而不是一律只记条目；有活动则维持只记条目。
- **派发结果可见**：派发失败或会话不可用时，任务标记「等待智能体上线」（而非误导性的「进行中」），并在任务行/详情可见；会话上线或下次操作时自动补发。
- **派发状态记录**：任务记录最近派发时间，供"无活动"判定与 UI 展示使用。

## Capabilities

### New Capabilities

- `dispatch-reliability`：任务/返工派发的可达性保障——离线可感知、可重派、状态对用户可见。

## Impact

- `teamTaskRoutes.ts`（request_changes 的 needsFix 分支、start 路径）、`TeamProvisioningService.dispatchTask`（失败检测与返回）、`Task` 模型（lastDispatchAt/waitingForAgent）、收件箱任务行状态映射（新增「等待上线」态）。
- 不改 needsFix 一轮多条意见不放大 revisionCount 的既有语义（计数仍只翻第一次，重派不重复计数）。

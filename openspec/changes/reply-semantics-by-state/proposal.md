# Proposal: 线程回复语义按任务状态区分

## Why

任务「待你补充」（needsClarification='user'）时，用户在收件箱没有任何补充入口；且线程回复一律按 request_changes 处理——用户的澄清回答会被错误地记为待办反馈，agent 也不会被唤起。回复语义必须随任务状态区分：补充说明、修改意见、普通讨论是三种不同动作。

## What Changes

- **待你补充态**：收件箱线程突出展示 agent 的澄清问题；回复框提示「回复即补充说明」，提交后——作为讨论消息发给 agent 会话、自动清除 needsClarification 标记、重新派发执行；**不**创建反馈条目、不翻转评审状态。
- **review/needsFix 态**：维持现状（回复=修改意见，request_changes 语义）。
- **其他状态**：回复=普通讨论消息（走 send-message + 派发），不创建反馈条目。
- 回复框提示文案随状态切换（补充说明/提出修改意见/发送讨论），让语义对用户透明。

## Capabilities

### New Capabilities

- `reply-semantics-by-state`：收件箱线程回复按任务状态分派为补充说明、修改意见或普通讨论。

## Impact

- `TaskReviewThread`/`CollaborativeInboxView`（回复框语义与提交分派）、`teamTaskRoutes`（clarification 清除复用既有 POST /:id/clarification）、消息派发通路（send-message → direct CLI）。
- 与 dispatch-reliability 的重派逻辑复用（补充说明后派发遵循 waitingForAgent 语义）。

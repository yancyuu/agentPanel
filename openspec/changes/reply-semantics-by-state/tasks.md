# Tasks: 线程回复语义按状态区分

## 1. 提交分派

- [x] 1.1 回复提交按状态分派：needsClarification='user' → send-message 讨论 + POST clarification 清除 + 派发；review/needsFix → request_changes（现状）；其他 → send-message 讨论 + 派发
- [x] 1.2 补充说明派发遵循 waitingForAgent/recordDispatchOutcome 语义

## 2. UI

- [x] 2.1 待补充态：线程突出展示 agent 澄清问题；回复框提示「回复即补充说明」；提交中/失败状态可见
- [x] 2.2 提示文案随状态切换（补充说明/提出修改意见/发送讨论）

## 3. 测试

- [x] 3.1 三种状态的提交分派、clarification 清除、不建反馈条目、评审状态不变、文案切换
- [x] 3.2 全量 vitest + typecheck

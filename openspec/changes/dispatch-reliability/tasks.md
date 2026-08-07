# Tasks: 派发可靠性

## 1. 模型与判定

- [x] 1.1 Task 增加 waitingForAgent/lastDispatchAt；toTeamTask 输出
- [x] 1.2 hasAgentActivitySinceNeedsFix（线程 agent 消息 > 最新 needsFix 事件时间，或团队会话存活）

## 2. 派发送达与等待态

- [x] 2.1 dispatchTask 返回 delivered；不可达时路由置 waitingForAgent + lastDispatchAt，可达时清除
- [x] 2.2 needsFix 分支：无活动 → 重派（携带全部 open 反馈），有活动 → 只记条目；revisionCount 语义不变
- [x] 2.3 spawnSession 成功钩子补发该团队 waiting 任务

## 3. UI

- [x] 3.1 收件箱任务行/详情状态映射：waitingForAgent → 「等待智能体上线」（amber，最高优先级）

## 4. 测试

- [x] 4.1 重派/只追加两分支、revisionCount 不变、等待态置位清除、补发钩子、UI 映射
- [x] 4.2 全量 vitest + typecheck；E2E 冒烟补一条 waiting 场景（可选，未做——路由级测试已覆盖 waiting 置位/清除/补发）

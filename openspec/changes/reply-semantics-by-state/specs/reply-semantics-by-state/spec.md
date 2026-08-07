## Purpose

收件箱线程的回复动作随任务状态获得正确语义：待补充时回复即补充说明并唤起 agent，评审时回复即修改意见，其余情况回复即普通讨论——用户无需理解内部状态机。

## ADDED Requirements

### Requirement: 待你补充态的补充入口

任务 needsClarification 为 user 时，收件箱线程 SHALL 突出展示 agent 的澄清问题，回复框提示「回复即补充说明」。提交后系统 MUST：将内容作为讨论消息发送到该任务线程并派发给 agent 会话、自动清除 needsClarification 标记；MUST NOT 创建反馈条目、MUST NOT 改变评审状态。派发遵循 waitingForAgent 语义。

#### Scenario: 补充说明唤起 agent

- **WHEN** 任务处于待你补充，用户在线程回复框提交「官网项目在 /path/x，改第二屏」
- **THEN** 消息进入任务线程并派发 agent，needsClarification 清除，反馈条目数不变，评审状态不变

### Requirement: 评审态回复维持修改意见语义

任务处于 review 或 needsFix 且非待你补充时，回复 MUST 维持 request_changes 语义（创建 open 反馈条目并退回），提示文案为「回复即提出修改意见」。

#### Scenario: 评审态回复仍是意见

- **WHEN** 任务处于 review，用户提交回复
- **THEN** 创建 open 反馈条目，任务翻 needsFix（或维持并追加），不发生 clarification 清除

### Requirement: 其他状态回复为普通讨论

任务不处于上述两种状态时，回复 SHALL 作为普通讨论消息发送并派发，不创建反馈条目，提示文案为「发送讨论消息」。

#### Scenario: 进行中任务收到讨论

- **WHEN** 任务进行中（非待补充、非评审态），用户提交回复
- **THEN** 消息进入线程并派发，不产生反馈条目，状态不变

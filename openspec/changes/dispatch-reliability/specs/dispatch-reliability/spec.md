## Purpose

任务与返工派发不再"发消息即忘"：agent 离线时用户能感知任务在等待而非进行中，恢复在线或新反馈到达时派发能真正送达。

## ADDED Requirements

### Requirement: needsFix 态的条件化再派发

任务处于 needsFix 时收到新反馈，系统 SHALL 判定自任务进入 needsFix 以来是否存在 agent 活动（该任务线程的 agent 消息或存活的执行会话）：无活动则重新派发返工（派发内容携带全部 open 反馈条目），有活动则仅追加反馈条目。无论是否重派，revisionCount MUST NOT 因同轮 needsFix 内的新反馈重复累计。

#### Scenario: 派发蒸发后新反馈触发重派

- **WHEN** 任务进入 needsFix 后无任何 agent 活动，用户提交新反馈
- **THEN** 系统重新派发返工，派发内容包含全部 open 反馈条目，revisionCount 不变

#### Scenario: agent 工作中只追加

- **WHEN** 任务进入 needsFix 后 agent 已有活动（已响应/执行中），用户追加新反馈
- **THEN** 仅追加反馈条目，不重新派发

### Requirement: 派发失败可见

派发（任务开始或返工）无法送达存活会话时，系统 SHALL 将任务标记为「等待智能体上线」并记录最近派发时间；该状态 MUST 在收件箱任务行与任务详情可见，区别于「进行中」。会话恢复在线或用户再次操作时系统 SHALL 自动补发。

#### Scenario: 无存活会话时标记等待

- **WHEN** 派发目标团队的会话不可用
- **THEN** 任务显示「等待智能体上线」并记录 lastDispatchAt，不显示「进行中」

#### Scenario: 上线后自动补发

- **WHEN** 任务处于「等待智能体上线」，该团队会话变为可用（或用户再次触发派发）
- **THEN** 系统补发派发并清除等待标记

## Purpose

交付评审以邮件线程形式呈现在收件箱：交付、退回、归档按任务聚合成一条线程，用户在收件箱内完成读成果、提意见、归档的完整评审闭环，无需进入任务详情。

## ADDED Requirements

### Requirement: 交付写入收件箱线程

agent 交付成果时（deliver_task，或 complete_task 携带结果），系统 SHALL 向团队消息流追加一条交付消息：source 为 runtime_delivery，conversationId 为 `task:<taskId>`（同一任务的全部评审事件共享，聚合成一条线程），taskRefs 指向该任务，summary 为本版变更摘要，正文包含版本号、变更摘要（如有）与成果全文。消息写入失败 MUST NOT 影响交付本身的状态变更（deliveries 追加与 reviewState 翻转）。

#### Scenario: 首次交付产生线程消息

- **WHEN** agent 对任务 T 首次调用 deliver_task 并携带成果与摘要
- **THEN** T 的 deliveries 新增第 1 版，reviewState 变为 review，且消息流出现一条 conversationId 为 `task:<T>`、source 为 runtime_delivery 的消息，正文含「交付 第 1 版」与成果全文

#### Scenario: 再次交付聚合为同一线程

- **WHEN** 任务 T 已有交付线程消息，agent 再次交付第 2 版
- **THEN** 新消息与既有交付消息共享同一 conversationId，summary 为第 2 版变更摘要

#### Scenario: 消息写入失败不阻塞交付

- **WHEN** 交付过程中消息流写入失败
- **THEN** deliveries 与 reviewState 照常更新，失败仅记录日志，不向 agent 报错

### Requirement: 回复线程即提出修改意见

在收件箱评审线程中，用户 SHALL 能通过线程底部的回复框提交修改意见。提交 MUST 等同于 request_changes：创建一条 open 状态的反馈条目、任务退回 needsFix、触发返工派发，并在同一线程追加一条 from 为 user 的回复消息。任务已处于 needsFix 时，继续提交意见 MUST 只追加反馈条目，不重复累计退回次数、不重复派发返工。

#### Scenario: 回复创建反馈条目

- **WHEN** 任务处于 review 态，用户在线程回复框输入意见并提交
- **THEN** 任务新增一条 open 反馈条目（text 为意见内容），reviewState 变为 needsFix，线程追加一条 from=user 的回复消息

#### Scenario: 一轮退回连续多条意见

- **WHEN** 任务已处于 needsFix 态，用户再次提交一条意见
- **THEN** 仅新增一条 open 反馈条目，revisionCount 不变，不重复派发返工

### Requirement: 选中成果文字提出锚定意见

在收件箱的交付邮件卡片上，用户 SHALL 能选中成果正文中的文字并通过悬浮框提交意见，系统 MUST 创建带 quote 锚点（选中文本，超 200 字符截断）的 open 反馈条目。悬浮框打开期间，原文中被选中的文字 MUST 保持可见高亮，关闭时清除。

#### Scenario: 选中文字提交锚定意见

- **WHEN** 用户在交付邮件卡片的成果正文选中一句话并点击「对此提意见」，在悬浮框中输入意见并提交
- **THEN** 创建一条 open 反馈条目，其 anchor 为 `{kind:'quote', quote:<选中文本>}`，反馈列表中该条目展示引用片段

#### Scenario: 悬浮框打开期间高亮保留

- **WHEN** 悬浮框处于打开状态
- **THEN** 成果正文中被选中的文字保持可见高亮；悬浮框关闭（提交/取消/Esc/点击外部）后高亮清除

### Requirement: 归档操作与拦截

收件箱线程头部 SHALL 提供「满意并归档」操作（任务处于 review 态时可见）。存在 open 反馈条目时，系统 MUST 弹出确认并逐条列出待处理反馈内容；用户确认通过后，遗留 open 条目 MUST 自动标记为已解决，随后完成归档，并在线程追加归档收尾消息。「需要修改」的评论对话框入口 MUST 移除。

#### Scenario: 无待处理反馈直接归档

- **WHEN** 任务处于 review 态且无 open 反馈条目，用户点击「满意并归档」
- **THEN** 任务置为 approved，线程追加「已通过并归档」消息

#### Scenario: 有待处理反馈时拦截

- **WHEN** 任务处于 review 态且存在 2 条 open 反馈条目，用户点击「满意并归档」
- **THEN** 弹出确认框，列出这 2 条反馈的文本内容；用户确认后这 2 条自动标记已解决并完成归档；取消则无任何变更

### Requirement: 任务详情成果区只读

完整任务详情中的「交付成果」区 MUST NOT 提供任何评审交互入口（通过、请求修改、内联意见编辑器、选中提意见），SHALL 保留版本切换、变更摘要、成果内容、反馈条目状态列表与锚点展示，并 SHALL 展示「评审请在收件箱进行」的引导文案。

#### Scenario: 任务详情无评审按钮

- **WHEN** 用户在完整任务详情中打开一个处于 review 态、含交付成果的任务
- **THEN** 成果区展示最新版成果与反馈状态列表，不出现「通过交付」「请求修改」按钮与意见编辑器，并可见前往收件箱评审的引导文案

### Requirement: 收件箱任务行反映交付动态

新交付到达时，收件箱左栏对应任务行 SHALL 更新最新动态（展示交付摘要）并标记未读，直至用户查看。

#### Scenario: 交付到达更新任务行

- **WHEN** agent 对任务 T 完成一次交付
- **THEN** 收件箱左栏 T 的任务行展示本次交付摘要作为最新动态，并呈现未读标记；用户查看该任务后未读标记消除

### Requirement: 沟通统一走消息，任务评论移除

任务 MUST NOT 再具有评论能力：评论的存储字段、读写接口、评论区 UI 与未读追踪全部移除，历史评论数据弃置不迁移。任务相关的沟通与评审交流 SHALL 一律经消息线程（`task:<taskId>`）进行，系统 MUST NOT 存在第二种沟通载体。

#### Scenario: 任务详情无评论区

- **WHEN** 用户打开任意任务的完整详情
- **THEN** 不存在评论区与评论输入框；需要交流时可见的入口指向消息/收件箱

#### Scenario: 评论接口不再可用

- **WHEN** 调用原评论写入接口
- **THEN** 接口不存在或返回 404，任务数据不再包含评论字段

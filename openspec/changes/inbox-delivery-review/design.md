# Design: 交付评审邮件线程

## Context

前置能力已在分支代码中落地（见 proposal「Impact」末尾）：`deliveries[]` 版本化、`FeedbackItem` 条目化（open/resolved、approve 拦截）、`FeedbackAnchor`（quote/hunk）、`historyEvents`、选中提意见悬浮框——它们解决了「成果被覆盖」「反馈无锚点」「轮次无增量」三个数据层问题。本设计解决剩下的交互层问题：评审动作从任务详情搬进收件箱，以邮件线程为载体。

现有可复用通路：

- 消息流：`~/.hermit/teams/<slug>/messages/group.jsonl`，`TeamWorkspaceService.appendMessage` 写入，`GET /api/teams/:name/messages` 游标读取，`POST send-message` 的「append + `broadcastSse('team-change',{type:'inbox'})`」广播模式；渲染端 SSE `type:'inbox'` → `refreshTeamMessagesHead` 自动刷新。
- `InboxMessage` 已有 `source`（含未使用的 `'runtime_delivery'`）、`conversationId`、`taskRefs`、`summary` 字段——线程模型不需要任何新字段。
- 收件箱 UI：`CollaborativeInboxView` 两栏（左任务行、右 TaskDetailPanel inline）；header 已有「满意并归档」。

## Goals / Non-Goals

**Goals**

- 交付、退回、归档三个评审事件在收件箱形成一条按任务聚合的邮件线程，用户不进任务详情即可完成完整评审闭环。
- 回复线程 = 创建 open 反馈条目（复用 request_changes 语义），用户无需理解「反馈条目」这个概念。
- 任务详情成果区只读化后，信息（版本/摘要/反馈状态）依然完整可查。

**Non-Goals**

- 不复活旧的私信邮件 UI（`InboxThreadList`/`InboxThreadDetail`，已是死代码）。
- 不做跨团队 delivery 的线程通知（跨团队 dispatch 本身未实现）。
- 不做邮件线程的独立已读模型（沿用任务行既有未读逻辑）。
- hunk 锚点的创建 UI 不在本轮（quote 锚点已覆盖文本成果；代码成果的 hunk 评审仍在变更审查对话框）。

## Decisions

### D1：线程载体 = group.jsonl + `conversationId=task:<taskId>`，不新建存储

交付消息以 `source='runtime_delivery'` 追加到团队 group.jsonl，同一任务的交付/退回/归档共享 `conversationId=task:<taskId>`。理由：消息读取、SSE 刷新、未读通路全部现成，零新存储零新协议。备选「新建 review-thread.json」被否：与消息流双写必然漂移。

### D2：结构化数据为准，线程消息为投影——只写不读回

board.json 的 `deliveries`/`feedbackItems` 仍是评审状态的唯一权威来源；线程消息是**人类可读的投影**，只追加、不作为 UI 状态的数据源（UI 状态读 board，邮件流展示读消息）。若消息写入失败，评审状态不受影响（catch 后仅记日志）。理由：避免「两套数据互相打架」；邮件流允许与状态有短暂不一致，状态不允许。

消息格式（交付示例）：

```json
{
  "from": "<assignee>", "to": "user",
  "source": "runtime_delivery",
  "conversationId": "task:t_ms9zz5jm_09bur3",
  "taskRefs": [{ "taskId": "t_ms9zz5jm_09bur3", "displayId": "t_ms9zz5", "teamName": "team-aa5s" }],
  "summary": "按反馈重写主副标题…",
  "text": "交付 第 2 版\n\n【本版变更摘要】…\n\n<成果全文>",
  "timestamp": "…", "read": true
}
```

退回（request_changes）写 `from='user'` 的回复消息（有 quote 锚点时引用片段进 text 引用块）；归档写「已通过并归档（第 N 版交付）」收尾消息。

### D3：收件箱评审界面 = 邮件流，数据渲染优先读结构化字段

右栏选中任务时，评审区按时间序合并渲染 `deliveries`（交付邮件卡片）与 `feedbackItems`（回复邮件），而非解析线程消息文本。理由：结构化字段渲染版本号/摘要/锚点/状态可靠且已有组件（版本切换、FeedbackAnchorView）；线程消息承担「收件箱列表预览 + 未读 + 归档后留存对话记录」的职责。底部回复框提交走 `updateKanban request_changes`（既有通路，自动建 FeedbackItem + 退回 + 派发返工），**不经过 send-message**——回复消息由 request_changes 在后端写入，保证 D2 的单向投影。

### D4：「需要修改」评论对话框删除，选中提意见迁移到交付邮件卡片

收件箱 header 的 ReviewDialog 入口删除；回复框提示文案「回复即提出修改意见」。选中提意见悬浮框（quote anchor）从 TaskDeliveriesSection 迁移到交付邮件卡片的成果正文上，交互不变（悬浮 popover、200 字符截断、Custom Highlight 保留选中高亮）。任务详情（完整版）成果区只读 + 引导文案「评审请在收件箱进行」。

### D5：一轮退回多条意见不放大退回计数（沿用既有语义）

回复框可连续提交多条意见；后端已有「needsFix 态下 request_changes 只追加反馈条目、不重复翻转状态/累计 revisionCount/重复派发」语义，直接复用。

### D6：架构决策——评论删除、评审状态单一事实源

依据 openspec/config.yaml 的工作台宪法（4 概念 + 全投影），本变更同时落实两条收敛：

- **任务评论整体移除**：评论的存储字段（Task.comments）、读写路由、评论区 UI（TaskCommentsSection/TaskCommentInput）、未读追踪（commentReadStorage/useUnreadCommentCount 等）全部删除；沟通与评审统一走消息线程（D1 的 `task:<taskId>` 已统一评审会话）。历史评论数据弃置不迁移。涉及面大但作为本变更的一部分一次做净，不留双沟通载体。
- **评审状态以 historyEvents 为单一事实源**：`reviewState`/`kanbanColumn` 一律视为派生值，任何新逻辑不得直接读写字段作为判断依据；后续独立变更负责把字段改为纯派生、消除双写。

## Risks / Trade-offs

- [消息写入失败导致邮件流缺一封，但状态已变] → D2 已隔离：状态权威在 board；UI 以结构化数据渲染，邮件流缺一封不影响评审闭环；失败记 warn 日志即可。
- [老任务没有线程消息，收件箱邮件流为空] → 可接受：评审区按 deliveries/feedbackItems 渲染，不依赖消息；新交付自然产生线程。
- [交付成果全文进 group.jsonl，消息文件体积增长] → 与成果本身同量级；group.jsonl 已是 append-only 大文件模型，暂不引入截断，后续可按需加「成果超 N 字符存摘要 + 链接」。
- [用户在任务详情找不到评审入口的过渡期困惑] → 只读区加引导文案；「满意并归档」保留在收件箱 header，位置与原来一致。

## Migration Plan

无数据迁移：board.json 模型不变；group.jsonl 只追加。老任务的评审状态由 deliveries/feedbackItems 正常渲染。回滚 = 还原代码，消息流里已写入的评审线程消息无害（普通消息展示）。

## Open Questions

- 交付邮件是否需要触发系统级通知（角标/声音）？当前仅有收件箱未读，留待通知体系统一处理。

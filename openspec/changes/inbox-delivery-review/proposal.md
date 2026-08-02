# Proposal: 交付评审搬进收件箱（邮件式交互）

## Why

任务交付成果的迭代评审此前以「评论」为唯一载体：成果是重资产，但每一轮修改都要在评论流里描述位置、全文重审、全量重做，轮次成本极高。前置工作已在任务详情内落地「成果版本化 + 反馈条目化 + 锚点」，但用户验收后确认：评审动作本身仍不应该是任务详情里的一组按钮和编辑器，而应该是**收件箱里的邮件式交互**——交付像邮件一样到达，用户在收件箱里读成果、回复意见、满意归档。任务详情回归信息展示。

## What Changes

- **交付即邮件**：agent 交付（`deliver_task` / `complete_task` 带结果）时，向团队消息流（group.jsonl）写入一条 `source='runtime_delivery'` 的交付消息，同一任务的所有交付串成一条线程（`conversationId=task:<taskId>`），收件箱出现新交付并标记未读。
- **回复即退回意见**：在收件箱的评审线程里回复交付邮件，等同于提出修改意见——自动创建 open 状态的反馈条目（FeedbackItem）、任务退回 needsFix、派发返工；不再经过「评论」。
- **选中即提意见（保留并迁移）**：在交付邮件卡片上选中文字，悬浮框提意见，自动生成带 quote 锚点的反馈条目。
- **满意归档留在收件箱**：通过操作保留在收件箱线程头部；有 open 反馈时拦截确认（逐条列出），强制通过则自动关闭遗留反馈。
- **任务详情只读化**：完整任务详情的「交付成果」区移除全部评审交互（通过/请求修改按钮、内联编辑器、选中提意见），保留版本切换、摘要、反馈状态展示，并给出「评审请在收件箱进行」引导。**BREAKING**：任务详情不再提供评审入口。
- **删除「需要修改」评论对话框入口**：收件箱头部的 ReviewDialog（写评论式退回）被回复框取代。
- **任务评论整体移除**（BREAKING）：沟通统一走消息线程，任务评论的存储字段、读写路由、评论区 UI、未读追踪全部删除；历史评论数据不做迁移（弃置）。

## Capabilities

### New Capabilities

- `delivery-review-thread`：交付评审邮件线程——交付/退回/归档事件写入团队消息流并按任务串成线程，收件箱以邮件流形态呈现评审过程，回复线程即创建反馈条目。

### Modified Capabilities

- 无（`openspec/specs/` 当前无既有 spec；任务详情的成果展示属首次规范化的展示行为，并入 `delivery-review-thread` 的只读化需求一并描述，不单独设 capability）。

## Impact

- **后端**：`src/main/services/team-management/mcpTaskTools.ts`（deliver/complete 写消息）、`src/main/routes/teamTaskRoutes.ts`（request_changes/set_column 写消息）、`src/main/services/team-management/TeamWorkspaceService.ts`（appendMessage 复用）、SSE 广播（`team-change` type:'inbox'）。
- **前端**：`src/features/collaborative-workbench/renderer/ui/CollaborativeInboxView.tsx`（邮件线程评审界面、删除「需要修改」入口）、`src/renderer/components/team/dialogs/TaskDetailPanel.tsx` + `TaskDeliveriesSection.tsx`（只读化）、左栏任务行投影（交付消息进入未读/最新动态）。
- **数据**：`~/.hermit/teams/<slug>/messages/group.jsonl` 新增评审线程消息；board.json 模型不变（deliveries/feedbackItems 已就位）。
- **已落地的前置能力**（本变更的依赖，代码已在分支上）：deliveries 版本化、FeedbackItem 条目化与 approve 拦截、FeedbackAnchor（quote/hunk）、historyEvents 时间线、选中提意见悬浮框。

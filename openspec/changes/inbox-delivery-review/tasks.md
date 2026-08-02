# Tasks: 交付评审搬进收件箱

## 1. 后端：评审事件写线程

- [x] 1.1 `mcpTaskTools.ts`：deliver_task 成功后 appendMessage（source='runtime_delivery'，conversationId=`task:<taskId>`，taskRefs，summary，正文=版本号+摘要+成果全文），写失败仅记日志；complete_task 带 result 记 delivery 时同样写消息
- [x] 1.2 `teamTaskRoutes.ts`：request_changes 追加 from='user' 回复消息（含 quote 引用块，如有 anchor）
- [x] 1.3 `teamTaskRoutes.ts`：set_column(approved) 追加「已通过并归档（第 N 版交付）」收尾消息
- [x] 1.4 三处写入后 broadcastSse `team-change` type:'inbox'
- [x] 1.5 确认 `GET /api/teams/:name/messages` 正常返回 `task:` 前缀 conversationId 的消息（不被 inboxThreadProjection 的过滤规则误伤）

## 2. 收件箱：邮件式评审界面

- [x] 2.1 评审区组件：按时间序合并渲染 deliveries（交付邮件卡片：版本号、摘要高亮、成果全文可折叠、时间、MemberBadge）与 feedbackItems（回复邮件：含锚点引用、状态）；归档收尾标记
- [x] 2.2 底部回复框：提示「回复即提出修改意见」，提交走 updateKanban request_changes；提交后清空并可连续提交
- [x] 2.3 交付邮件卡片迁移「选中文字 → 悬浮框提意见」（quote anchor、200 字符截断、Custom Highlight 选中高亮保留）
- [x] 2.4 header 删除「需要修改」按钮及 ReviewDialog 入口；「满意并归档」保留（含 open 反馈拦截确认，逐条列出）
- [x] 2.5 左栏任务行：交付消息进入最新动态与未读逻辑（按 design D2/D3 选简单可靠方案）

## 3. 任务详情只读化

- [x] 3.1 完整任务详情的交付成果区：删除通过交付/请求修改按钮、内联编辑器、选中提意见；保留版本切换、摘要、反馈状态列表、锚点展示
- [x] 3.2 加引导文案「评审请在收件箱进行」

## 3A. 评论整体移除（D6）

- [x] 3A.1 存储：Task 模型删除 comments 字段；删除 addTaskComment 及 POST `/api/teams/:name/tasks/:id/comments` 路由
- [x] 3A.2 共享类型：删除 TaskComment/TaskCommentType/AddTaskCommentRequest 及 TeamTask.comments；清理全部引用
- [x] 3A.3 前端：删除 TaskCommentsSection/TaskCommentInput、评论未读追踪（commentReadStorage/useUnreadCommentCount/useViewportCommentRead/taskCommentPendingReply 等）及各处角标；inboxProjection 等评论消费点改走消息/feedbackItems
- [x] 3A.4 历史评论数据弃置（board.json 旧 comments 字段读取时忽略），测试同步删除/改写

## 4. 测试与验证

- [x] 4.1 后端用例：deliver/request_changes/approved 的线程消息（conversationId、taskRefs、SSE 类型）、消息写失败不阻塞交付、needsFix 连续意见不放大计数
- [x] 4.2 前端用例：邮件流渲染（交付/回复/归档）、回复提交=request_changes、邮件卡片选中提意见（含高亮保留）、任务详情无评审按钮且有引导文案
- [x] 4.3 `pnpm vitest run` 相关套件 + `pnpm typecheck` 全绿
- [ ] 4.4 `pnpm desktop:dev` 重新打包，按 specs 全部 Scenario 逐条人工验收

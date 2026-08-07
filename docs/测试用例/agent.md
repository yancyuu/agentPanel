# Hermit 功能测试用例集（agent 执行 runbook）

> 本文件是 **agent 可执行的测试 runbook**,涵盖 Hermit 全部功能域的测试用例与验收标准。
> 每个用例含:前置/步骤、**验收通过**、**验收失败**、类型、优先级。
> 用例 ID 规则:`<域>-<功能>-<序号>`,如 `TEAM-004-005`。

---

## 0. 执行说明

### 0.1 环境准备
- **Node/包**: `pnpm install`(始终用 pnpm)。
- **两个运行形态**:
  - Electron 形态:`pnpm dev`
  - Web 形态:Fastify `pnpm dev:server`(:5680)+ Vite `pnpm dev:web`(默认 :5174,以实际日志为准)
- **测试工具链**:vitest ^3.1.4 + @vitest/coverage-v8 + happy-dom(组件)+ playwright ^1.60(e2e,**注意:当前无 playwright.config,需先建**)。
- **测试数据**:团队数据位于 `~/.hermit/teams/`;跨团队协作板 `~/.hermit/collab-board.json` + `collab-events.jsonl`;cc-connect `~/.hermit/cc-connect/`;会话 `~/.claude/projects/{encoded}/*.jsonl`。
- **安全约束**:不泄露 token/secrets;不跑 `pnpm lint:fix` 除非显式要求;提交不带 attribution trailer。

### 0.2 执行命令
```bash
pnpm test                         # 全量 vitest
pnpm test:coverage                # 覆盖率
pnpm test:coverage:critical       # 关键路径(vitest.critical.config.ts,含 stallMonitor)
pnpm typecheck 2>&1 | tail -20
pnpm build
# e2e(需先建 playwright.config):
npx playwright test
```
- 跑 build/typecheck/test 时一律 `| tail -20` 防止刷屏。

### 0.3 用例类型
| 类型 | 含义 | 工具 |
|---|---|---|
| unit | 纯函数/单模块 | vitest |
| integration | 跨模块/真实文件系统/SQLite | vitest |
| e2e | 真实 UI 全流程 | playwright |
| manual | 需人工观测(视觉/交互) | 人工 + 截图 |

### 0.4 优先级
- **P0**:核心链路/历史回归点/数据安全 — 必须全绿。
- **P1**:主功能完整性 — 发布前应绿。
- **P2**:体验/性能/边角 — 排期补。

### 0.5 报告格式(agent 执行后回填)
每条用例执行后输出一行:
```
[ID] PASS|FAIL|SKIP  实际现象(FAIL 时附证据:日志/截图/HTTP 响应)
```

---

## 1. 团队与跨团队协作（TEAM-*）

### [TEAM-001] 团队创建与供应
- **文件**:`src/main/services/teams-mvp/TeamProvisioningService.ts`、`TeamWorkspaceService.ts`、`src/renderer/components/team/dialogs/LaunchTeamDialog.tsx`
- **已有测试**:`TeamWorkspaceService.test.ts`(部分)

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-001-001 | `createTeam({teamName,bindProject,harness,workDir})` | `~/.hermit/teams/{slug}/` 创建,`team.json` 元数据正确,cc-connect project 建好 | 目录未建/team.json 损坏/cc-connect 失败 | integration | P0 |
| TEAM-001-002 | 创建时注入 CLAUDE.md 团队协作指令 | 含 `<!-- hermit:team-collaboration:start -->` 区块 + 可用团队列表 + 派单指令 | CLAUDE.md 未建/缺必需区块 | unit | P1 |
| TEAM-001-003 | 创建时注入 hermit-tasks MCP 配置 | `.claude/settings.json` 含 hermit-tasks MCP,URL 指向本地端口 | settings.json 未更新 | unit | P1 |
| TEAM-001-004 | `createCcProject=true` 触发 cc-connect 重启 | cc-connect restart 成功,项目绑定生效 | 未重启/绑定未生效 | integration | P0 |
| TEAM-001-005 | `deleteTeam(slug,{deleteFiles:false})` 归档 | 目录改名为 `.archived-{slug}-{ts}` | 目录残留/未归档 | integration | P1 |
| TEAM-001-006 | `deleteTeam(slug,{deleteFiles:true})` 全删 | 目录及内容全删 | 有残留 | integration | P1 |

- **风险点**:cc-connect 重启失败但目录已建 → 不一致;CLAUDE.md 注入在已有文件上可能重复/冲突;MCP 配置可能覆盖用户配置。

### [TEAM-002] 团队成员管理
- **文件**:`TeamWorkspaceService.ts`、`src/shared/types/team.ts` · **已有测试**:无

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-002-001 | `updateTeam()` 增成员 + 角色 | members 含新成员,角色正确 | 未加/角色错 | unit | P1 |
| TEAM-002-002 | 删成员 | members 移除,历史消息保留 | 成员仍在/历史丢 | unit | P2 |
| TEAM-002-003 | 成员 color 分配 | color 保存且 UI 正确显示 | 未存/显示错 | unit | P2 |
| TEAM-002-004 | 成员 `isolation='worktree'` | 成员在独立 git worktree 运行 | 仍在主工作目录 | integration | P1 |

### [TEAM-003] Kanban 任务 CRUD 与状态流转
- **文件**:`TeamWorkspaceService.ts`、`src/renderer/components/team/kanban/KanbanBoard.tsx`、`KanbanTaskCard.tsx` · **已有测试**:`TeamWorkspaceService.test.ts`(部分)

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-003-001 | `createTask({title,description,status:'todo'})` | 任务文件建好,含正确 ID/title/status/order | 未建/字段缺 | unit | P0 |
| TEAM-003-002 | `patchTask` 状态流转 todo→in_progress→done | 状态更新,updatedAt 刷新 | 未更新/时间戳不变 | unit | P0 |
| TEAM-003-003 | `patchTask` 设置 assignee | 正确分配 | 分配失败/成员不存在 | unit | P1 |
| TEAM-003-004 | Agent 完成后写 result | result 含结果摘要 | 空/未写 | integration | P0 |
| TEAM-003-005 | `deleteTask` | board.json 移除 | 仍在 | unit | P2 |
| TEAM-003-006 | 同列多任务 order | order 递增 | 重复/不递增 | unit | P1 |
| TEAM-003-007 | 手动改 done 时若 agent 处理中 | 返回 409 `Agent 正在处理中,不能手动完成` | 允许误改 | integration | P1 |

- **风险点**:并发更新竞态;删任务影响 dispatch 引用。

### [TEAM-004] 跨团队派单完整生命周期
- **文件**:`src/main/services/teams-mvp/TaskDispatchService.ts`、`CollaborationBoardService.ts`、`src/main/ipc/crossTeam.ts`、`src/main/server.ts`(`/api/cross-team/*`)·**已有测试**:`TaskDispatchService.test.ts`(较全)

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-004-001 | `dispatchTask`(send) | 目标团队 TODO 出现任务,`dispatchMeta.status='received'`,collab board 记录 | 无任务/dispatchMeta 缺 | integration | P0 |
| TEAM-004-002 | `startDispatchedTask`(用户点启动) | status→in_progress,`onRuntimeStart` 触发,collab board→in_progress | 未启/runtime 未执行 | integration | P0 |
| TEAM-004-003 | `acceptTask`(仅签收,不推进执行) | dispatchMeta.status 仍 received,remoteTaskId 设置,返回 taskId | 状态错误推进/ID 缺 | unit | P1 |
| TEAM-004-004 | `deliverTask`(需 task 已 done) | collab→delivered,来源团队收待审核通知 | 状态未变/通知未发 | integration | P0 |
| TEAM-004-005 | `approveTask`(需 delivered) | collab→approved,双方收完成通知 | 状态未变/通知缺 | integration | P0 |
| TEAM-004-006 | `rejectResult`(revision) | collab→revision,revisionCount+1,目标团队收反馈 | 未变/反馈未递 | integration | P0 |
| TEAM-004-007 | `rejectTask`(拒绝接收) | collab→rejected,来源团队收拒通知 | 未变/通知缺 | integration | P1 |
| TEAM-004-008 | Redis 远程派单 | Redis stream 收到,远程团队建 TODO | 写入失败/未收到 | integration | P0 |
| TEAM-004-009 | deadlineMinutes 超时 | 超时→failed | 仍 received | integration | P1 |
| TEAM-004-010 | 状态机非法跳变护栏 | 非法跳变返回 `Invalid collab task transition: X -> Y; expected Z`(HTTP 200, ok:false) | 静默允许非法跳变 | unit | P0 |
| TEAM-004-011 | deliver 前置护栏:任务未 done | 返回 `Task result cannot be delivered before the agent marks the task done.` | 允许未完成即交付 | unit | P0 |
| TEAM-004-012 | approved 后重复 deliver | 抛 `already been approved and cannot be delivered again` | 允许重复交付 | unit | P1 |

- **风险点**:Redis 断连丢派单;启动锁死锁;重复派单;审批后重复交付。本会话已实证:派单/签收全绿,deliver/approve 护栏正确拦截(返回业务错误,非崩溃)。

### [TEAM-005] 消息系统（历史回归重灾区）
- **文件**:`TeamWorkspaceService.ts`(appendMessage/readMessages)、`src/renderer/utils/teamMessageKey.ts`、`mergeTeamMessages.ts`、`teamMessageFiltering.ts` · **已有测试**:`TeamWorkspaceService.test.ts`、`test/renderer/utils/mergeTeamMessages.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-005-001 | appendMessage 传入 messageId | messageId 保持不变,不重新生成 | ID 被重生成→去重失效 | unit | **P0 回归** |
| TEAM-005-002 | 相同 messageId 经 mergeTeamMessages | 重复被去除,保留最新 | 出现重复消息 | unit | **P0 回归** |
| TEAM-005-003 | 消息按 timestamp 排序 | 升序 | 顺序乱 | unit | P1 |
| TEAM-005-004 | TeamMessagesFilter(from/to/showNoise/searchQuery) | 只显示符合条件 | 过滤不生效 | unit | P1 |
| TEAM-005-005 | `sendCrossTeamMessage` | 目标团队收到,source='cross_team' | 未收到/source 错 | integration | P0 |
| TEAM-005-006 | 标记已读 | read 状态保存 + UI 反映 | 未存/丢失 | unit | P2 |
| TEAM-005-007 | `loadOlderTeamMessages` 分页 | 返回更早消息,nextCursor 正确 | 分页失效/重复 | integration | P1 |
| TEAM-005-008 | relayOfMessageId 引用 | 原始消息可见时 relay 隐藏 | relay 重复显示 | unit | P1 |
| TEAM-005-009 | user.json 缺 messageId | TeamInboxReader 用 sha256(from+ts+text) 生成确定性 ID | ID 不稳定→重复 | unit | **P0 回归** |
| TEAM-005-010 | relayMemberInboxMessages 保持禁用 | 不被意外调用(无 lead 代答/重复/循环) | 重新启用导致循环 | unit | **P0 回归** |

- **风险点**:CLAUDE.md 明确标注——messageId 传播失效、mergeTeamMessages 去重、relayOfMessageId、relay 循环、duplicate messages。**这些必须有专门回归用例。**

### [TEAM-006] 代码评审 Diff
- **文件**:`src/renderer/components/team/ToolApprovalDiffPreview.tsx`、`ToolApprovalSheet.tsx`、`dialogs/ToolApprovalSettingsPanel.tsx` · **已有测试**:无

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-006-001 | Diff 预览生成 | 显示 before/after 对比 | 未生成/显示错 | unit | P1 |
| TEAM-006-002 | 点"允许" | 工具调用被批准,执行继续 | 未批准/超时 | integration | P0 |
| TEAM-006-003 | 点"拒绝" | 工具调用被拒,Agent 收拒绝响应 | 仍执行 | integration | P0 |
| TEAM-006-004 | timeoutAction='deny' 超时 | 超时自动拒 | 仍等待/自动允许 | integration | P1 |
| TEAM-006-005 | autoAllowFileEdits / autoAllowSafeBash | 符合条件自动批准 | 不生效 | unit | P2 |

### [TEAM-007] Solo 模式 · [TEAM-008] 结构化 TaskRef · [TEAM-009] @mention
- **文件**:`src/shared/types/team.ts`(TaskRef)、`src/renderer/utils/mentionLinkify.ts`、`components/ui/MentionableTextarea.tsx` · **已有测试**:无(TeamRef/mention);@mention 检测在 `useMentionDetection.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-007-001 | 单成员团队启动 | 正常启动,无协调开销 | 启动失败/异常 | integration | P2 |
| TEAM-008-001 | TaskRef 序列化/反序列化 | taskId/displayId/teamName 保持 | 字段丢/解析错 | unit | P1 |
| TEAM-008-002 | 消息内 TaskRef 渲染 | 可点击,跳任务详情 | 未渲染/链接无效 | unit | P2 |
| TEAM-008-003 | 任务描述引用 TaskRef | 引用关系保存显示 | 丢失/循环引用 | unit | P2 |
| TEAM-009-001 | `@成员名` | 识别 mention,出候选列表 | 未识别/误识别 | unit | P1 |
| TEAM-009-002 | `@团队名` | 识别团队 mention,可跳转 | 未识别/链接无效 | unit | P1 |
| TEAM-009-003 | mention 渲染彩色徽章 | 颜色与成员一致 | 纯文本/颜色错 | unit | P2 |
| TEAM-009-004 | 跨团队消息带 @mention | 目标团队正确解析 | 失效/解析错 | integration | P1 |
| TEAM-009-005 | 零宽元数据编码任务引用 `#task-id​` | 蓝色高亮 + 光标对齐 + 持久身份 | 光标错乱/身份漂移 | unit | P1 |

### [TEAM-010] @team 提及派单（团队协作冒烟 · 用户面入口）
- **文件**:`src/renderer/components/team/loop-console/loopSendIntent.ts`(`@team`→cross-team-task)、`useLoopCommandSuggestions.ts`(teamSlugs 候选)、`components/team/messages/MessageComposer.tsx`、`src/main/ipc/crossTeam.ts` + `services/teams-mvp/TaskDispatchService.ts`(实际派单)·**已有测试**:`loopSendIntent.test.ts`(2 份互补:`test/renderer/...` 解析路由 + `@team`、`src/renderer/...` validation 门控)已覆盖 **001 / 003 / 004**:`@已知团队`→cross-team-task(001)、`@未知团队` 不在 teamSlugs→回退 message 不误派(003)、cross-team-task **源团队离线仍可派单** + 防御性 `!toTeam` 守卫(004)。005(integration)/ 006(e2e)/ 007 需 gstack 实测,不在单测范围
- **与 TEAM-004 的区别**:TEAM-004 测**后端派单生命周期 API**(send/start/deliver/approve);本节测**用户在团队内 `@别的团队` 提及 → 真实派单 → 对端处理 → 回流**的端到端协作冒烟,把「解析 / 候选 / 校验 / 派单 / 双侧可见性」串成一条用户路径。

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| TEAM-010-001 | 团队内 `@teamB <任务>` 解析为跨团队意图 | `parseLoopSendIntent` → kind=`cross-team-task`、toTeam=`teamB`、subject=`<任务>` | 误判为普通消息/runtime | unit | P0 |
| TEAM-010-002 | `@` 触发团队候选 | 候选列出已知 teamSlugs,选中后插入 | 无候选/列错 | unit | P1 |
| TEAM-010-003 | `@未知团队` 不派单 | slug 不在 teamSlugs → 回退普通消息,不创建跨团队任务 | 误派单到不存在的团队 | unit | P1 |
| TEAM-010-004 | `validateLoopSendIntent` 跨团队校验 | cross-team-task **源团队离线仍可派单**(异步交给对端,不受 isTeamAlive 拦)+ 缺 toTeam 时防御性拒绝(非静默失败) | 源团队离线误拦派单 / 静默失败 | unit | P1 |
| TEAM-010-005 | 提交 `@teamB 任务` → 真实派单 | teamB 收 TODO、dispatchMeta.status=`received`、collab board 记录(衔接 TEAM-004-001) | 未派单/目标未收 | integration | P0 |
| TEAM-010-006 | 端到端:teamB 处理 → deliver → teamA approve | received→in_progress→done→delivered→approved 全链路 + 双方通知 | 中断/状态错/通知缺 | e2e | P0 |
| TEAM-010-007 | 来源团队"外部派单"面板可见性 | 派出任务在 teamA 侧可见,状态实时同步 | 不见/状态滞后 | integration | P1 |

- **覆盖状态(2026-06-14)**:**001 ✅ live**(gstack 实测:输入 `@team-4` 后标签实时变 `派单到 team-4`)、**003 / 004 ✅ 单测**(`pnpm vitest run loopSendIntent` 16 例绿)、**005 ✅ integration**(gstack 实测:team-4 收 TODO `t_mqdisw1j_l7gza0`、`dispatchMeta.status=received`、collab-board 记录);**007 ⚠️ 发现 F-4**(派单落盘正确但 `/api/teams/:team/board`+「外部派单」面板读不到 → 见 QA 报告 F-4,待修复);006 e2e 待补。001/003/004 已纳入只读 cron `955ac08b`(v3)每 10 分钟回归。
- **风险点**:`@team` 解析依赖 teamSlugs 完整性(未知团队静默回退,见 003);意图解析→派单 API 之间脱节(解析对但没真派单,见 005);来源/目标双侧任务可见性不同步(007);与 TEAM-004 生命周期护栏的衔接。**冒烟最小集 = 001 + 005 + 006(P0)。**

---

## 2. 会话分析与上下文追踪（SESS-*）

### [SESS-001] JSONL 流式解析
- **文件**:`src/main/services/session-intelligence/SessionUsageParser.ts`、`LocalSessionScanner.ts`、`src/main/types/jsonl.ts` · **已有测试**:`SessionUsageParser.test.ts`、`LocalSessionScanner.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-001-01 | 标准 JSONL 解析 | 提取消息数 + token 使用 | 解析失败 | unit | P0 |
| SESS-001-02 | 大文件(10MB+)流式 | 内存稳定不溢出 | OOM | performance | P1 |
| SESS-001-03 | 空/损坏行 | 跳过无效行继续 | 整体崩溃 | unit | P1 |
| SESS-001-04 | 顶层 usage 字段(旧格式) | 正确聚合 token | 漏算 | unit | P1 |
| SESS-001-05 | 助手消息缺 usage | 不抛错,token 计 0 | 抛错 | unit | P1 |
| SESS-001-06 | 嵌套目录递归扫描 | 找到全部会话文件 | 漏文件 | unit | P1 |
| SESS-001-07 | 路径编码可移植(`/a/b`→`-a-b`) | 正确编码解码 | 跨平台错 | unit | P1 |

### [SESS-002] Chunk 构建（4 类）· [SESS-003] Metrics 聚合
- **文件**:`src/main/types/chunks.ts`、`src/renderer/utils/groupTransformer.ts`、`src/shared/utils/contextMetrics.ts` · **已有测试**:`groupTransformer.test.ts`、`contextMetrics.test.ts`(有限)

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-002-01 | UserChunk 构建(真实用户消息) | 单条用户消息独立成 chunk | 误并入他类 | unit | P0 |
| SESS-002-02 | AIChunk 构建 | 含全部助手响应 + 子代理 | 漏响应/子代理 | unit | P0 |
| SESS-002-03 | SystemChunk(命令输出) | 提取命令输出 | 误分类 | unit | P1 |
| SESS-002-04 | CompactChunk(压缩边界) | 创建压缩边界 chunk | 边界丢 | unit | P1 |
| SESS-002-05 | 4 类守卫 isXxxChunk | 正确识别 | 误判 | unit | P1 |
| SESS-003-01 | token 聚合(input+output+cache) | 总数正确 | 漏算 | unit | P0 |
| SESS-003-02 | 成本计算(按 model) | 成本正确 | 单价错 | unit | P1 |
| SESS-003-03 | 工具调用统计 | 次数 + 错误率正确 | 漏算 | unit | P1 |
| SESS-003-04 | 持续时间 | 毫秒级正确 | 负数/0 | unit | P2 |
| SESS-003-05 | 空 usage | 默认 0 | NaN | unit | P1 |
| SESS-003-06 | cache_read + cache_creation 分类 | 正确分类 | 混淆 | unit | P0 |

### [SESS-004] 上下文注入追踪（6 类）· [SESS-005] Compaction 重置
- **文件**:`src/renderer/utils/contextTracker.ts`、`src/renderer/types/contextInjection.ts` · **已有测试**:无

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-004-01 | claude-md 注入 | 检测企业/用户/项目 CLAUDE.md | 漏检测 | unit | P0 |
| SESS-004-02 | mentioned-file 注入(@文件) | 提取路径 + token 估算 | 漏 | unit | P1 |
| SESS-004-03 | tool-output 注入 | 聚合工具输出 token | 漏算 | unit | P1 |
| SESS-004-04 | thinking-text 注入 | 区分思考 vs 文本 token | 混淆 | unit | P2 |
| SESS-004-05 | team-coordination 注入(SendMessage/TaskCreate) | 追踪协调开销 | 漏 | unit | P1 |
| SESS-004-06 | user-message 注入 | 计算用户输入 token | 漏 | unit | P2 |
| SESS-004-07 | 累积上下文计算 | 多轮累积正确 | 重复计算/遗漏 | unit | P0 |
| SESS-005-01 | compaction 边界检测 | 检测 compact_summary | 漏检测 | unit | P0 |
| SESS-005-02 | 压缩后清空累积 | 重置注入状态 | 残留 | unit | P0 |
| SESS-005-03 | phaseNumber 递增 | 正确分配 | 错号 | unit | P1 |
| SESS-005-04 | 压缩后 cache 重建 | 重建缓存状态 | 错 | unit | P1 |
| SESS-005-05 | 压缩前后 token delta | 释放量正确 | 错 | unit | P1 |
| SESS-005-06 | post-compact 第一个助手消息测量 | 准确测量压缩后上下文 | 错 | unit | P0 |

### [SESS-006] Agent Block 包裹/剥离/解包
- **文件**:`src/shared/constants/agentBlocks.ts` · **已有测试**:`test/shared/constants/agentBlocks.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-006-01 | `wrapAgentBlock` | 正确加标签 + trim/格式 | 手拼标签 | unit | P0 |
| SESS-006-02 | `stripAgentBlocks`(UI 显示) | 移除全部 agent block | 残留 | unit | P0 |
| SESS-006-03 | `unwrapAgentBlock` | 移除标签保留内容 | 内容丢 | unit | P0 |
| SESS-006-04 | 旧格式兼容 | 正确处理所有历史格式 | 旧格式崩 | unit | P1 |
| SESS-006-05 | 嵌套 block | 正确处理嵌套 | 解包不全 | unit | P1 |

### [SESS-007] 消息类型守卫 · [SESS-008] Task/Subagent 过滤 · [SESS-009] Teammate 解析
- **文件**:`src/main/types/messages.ts`、`chunks.ts`、`src/renderer/utils/displayItemBuilder.ts` · **已有测试**:无

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-007-01 | isParsedRealUserMessage(isMeta:false + 字符串) | 正确识别真实用户消息 | 误判 meta | unit | P0 |
| SESS-007-02 | isParsedInternalUserMessage(isMeta:true + 数组) | 正确识别内部消息 | 误判 | unit | P1 |
| SESS-007-03 | isAssistantMessage | type:'assistant' 识别 | 漏 | unit | P1 |
| SESS-007-04 | isParsedHardNoiseMessage | 过滤系统元数据噪音 | 漏过滤 | unit | P1 |
| SESS-008-01 | Task tool_use 检测 | 识别 subagent 调用 | 漏 | unit | P0 |
| SESS-008-02 | Task↔subagent 配对(agent_id/parent_uuid) | 正确链接 | 错配 | unit | P0 |
| SESS-008-03 | 有 subagent 时过滤 Task tool_use | 不重复展示 | 重复展示 | unit | P0 |
| SESS-008-04 | orphaned Task(无匹配 subagent)保留 | 保留可见性 | 误删 | unit | P0 |
| SESS-008-05 | 并行 subagent | 正确标记并行 | 错标 | unit | P1 |
| SESS-009-01 | `<teammate-message teammate_id color summary>` 解析 | 正确解析为 TeammateMessageItem | 解析失败 | unit | P0 |
| SESS-009-02 | teammate 消息排除出 UserChunk | 渲染为卡片 | 误并入 UserChunk | unit | P0 |
| SESS-009-03 | SendMessage shutdown_response(approve:true) | 算作会话结束事件,非 ongoing | 误判 ongoing | unit | P1 |

### [SESS-010~012] LRU 缓存 / 虚拟滚动 / Post-Compact 恢复
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SESS-010-01 | LRU 满淘汰最少使用 | 淘汰正确 | 淘汰错项 | unit | P1 |
| SESS-010-02 | 缓存命中更新顺序 | LRU 顺序更新 | 不更新 | unit | P2 |
| SESS-011-01 | 1000+ 消息渲染 | 虚拟滚动只渲染可见项 | 卡顿/全渲染 | performance | P1 |
| SESS-011-02 | 滚动位置保持 | 切换后位置正确 | 跳顶 | integration | P2 |
| SESS-012-01 | 压缩后状态重建 | 正确恢复上下文状态 | 状态丢 | unit | P0 |
| SESS-012-02 | 压缩后累积 token 重算 | 正确重新累积 | 错算 | unit | P0 |

---

## 3. 系统管理 / Loop / 工作流 / 扩展 / MCP / CLI / 通知 / 集成

### [SYS-001] System Manager 核心
- **文件**:`src/main/services/system-manager/SystemManagerConfigService.ts` · **已有测试**:`test/main/services/system-manager/`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SYS-001-A | `getStatus()` | 返回 displayName/defaultWorkDir/selectedWorkDir/globalHermitWorkflowFolder/claudeCommand/localStatus;claude 存在→ready,缺失→missing-claude + error | 缺字段 | integration | P0 |
| SYS-001-B | 配置读写持久化 | 改 selectedWorkDir/workflowFolder → `~/.hermit/system-manager.json` 正确,重读一致 | 丢/错 | integration | P0 |
| SYS-001-C | 路径 `~` 扩展 + 无效目录校验 | `~` 正确扩展;无效目录抛"不是有效目录" | 不扩展/不校验 | unit | P1 |

### [SYS-002] Builtin Workflow Seeder
- **文件**:`BuiltinWorkflowSeeder.ts` · **已有测试**:`BuiltinWorkflowSeeder.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SYS-002-A | 播种 16 个内置 workflow | 全部复制到 `~/.claude/commands/hermit/`,daily-workflow-extraction 含 `hermit-builtin-workflow:v2-loop` | 缺/内容错 | integration | P0 |
| SYS-002-B | 用户编辑保护 | 已存在但无 v2-loop 标记的用户文件**不被**覆盖 | 覆盖用户编辑 | unit | P0 |
| SYS-002-C | stale 刷新 | 含旧版标记的文件被最新版替换 | stale 未更新 | unit | P1 |
| SYS-002-D | create-team 边界 | 含 `/api/teams/create`、`${HERMIT_API_URL:-http://127.0.0.1:5680}`、slug `^[a-z0-9][a-z0-9_-]*$`、"不自动启动 agent" 警告 | 边界缺 | unit | P0 |

### [SYS-003/004/005] Workflow Prompt / SystemManager UI / TaskBus 面板
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| SYS-003-A | `list(folder)` | 返回 folder/prompts[]/warnings[],每项含 id/label/filename/path/sizeBytes/updatedAt + builtin 元数据 | 缺字段 | unit | P1 |
| SYS-003-B | >256KiB 文件 | warnings 含"超过 256 KiB,已跳过",不入 prompts | 仍包含 | unit | P1 |
| SYS-003-C | `read(folder,id)` 不存在 id | 抛"未找到 Loop workflow" | 静默 | unit | P1 |
| SYS-004-A | SystemManagerView 渲染 | 显示 Admin Loop 标题 + 工作目录选择 + workflow 列表 | 关键元素缺 | unit | P1 |
| SYS-004-B | 点 workflow 执行 | 调 createLoopSession API | 流程中断 | integration | P1 |
| SYS-005-A | TaskBus 面板 | 显示 enabled/disabled + Redis 连接状态 + 遥测概览 | 显示错 | manual | P2 |

### [LOOP-001] Loop 直连 CLI
- **文件**:`src/main/services/direct-cli/DirectCliSessionManager.ts` · **已有测试**:`DirectCliSessionManager.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| LOOP-001-A | `spawn()` 启动 claude | 正确 stream-json 参数 + workDir + 写 `~/.claude/projects/{enc}/<id>.jsonl` | 启动失败 | integration | P0 |
| LOOP-001-B | 消息流传输 | 用户消息→NDJSON,接收 stream-json,SSE token 级转发 | 丢/格式错 | integration | P0 |
| LOOP-001-C | resumeSessionId | 用 `--resume`,历史上下文加载 | 恢复失败 | integration | P1 |
| LOOP-001-D | providerArgs(model/effort/flags) | 正确加入 CLI 参数 | 传递错 | unit | P1 |
| LOOP-001-E | CLI 进程崩溃 | 捕获并优雅报告,不拖垮主进程 | 主进程崩 | integration | P0 |

### [LOOP-002] cc-connect 集成 · [LOOP-003] Daily Workflow Extraction
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| LOOP-002-A | `/api/cc/*` 代理 | 正确代理到 cc-connect:9820,Authorization 透传 | 代理失败 | integration | P0 |
| LOOP-002-B | Bridge WS 连接 | 认证成功 + 收群聊消息 + 转发团队 SSE | 断/丢 | integration | P0 |
| LOOP-002-C | workDir 重新协调(placeholder) | 自动修正为正确工作目录 | 未更新 | unit | P1 |
| LOOP-003-A | daily-workflow-extraction 命令 | 只读扫描,输出候选清单 + 草案 | 报错 | manual | P2 |
| LOOP-003-B | 只读安全边界 | 不创建/不修改文件,只输出建议 | 违反只读 | unit | P1 |

### [EXT-001~004] 扩展商店 / MCP Library / Skills Watching / Capability Packs
- **已有测试**:`CapabilityPackLoaderService.test.ts`、`ExtensionStoreView.test.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| EXT-001-A | 插件目录加载 | 返回全部插件 + 元数据 + 分类 | 缺/分类错 | integration | P0 |
| EXT-001-B | 插件安装(多 harness 适配) | ClaudeCode/Cursor/Codex 适配器各写对配置,status→installed | 适配器错 | integration | P0 |
| EXT-001-C | 插件卸载 | 删配置,status→available | 残留 | integration | P1 |
| EXT-002-A | MCP 库列表 | 返回条目 + 工具定义 + 安装规范 | 缺 | integration | P1 |
| EXT-002-B | 自定义 MCP(HTTP/stdio) | 写 `~/.claude/settings.json` + 正确加载 | 安装失败 | integration | P1 |
| EXT-002-C | MCP 启用/禁用 | 工具出入可用列表 | 状态错 | integration | P1 |
| EXT-003-A | Skills watcher start | 250ms 去抖后触发 create 事件 | 不触发/延迟错 | integration | P1 |
| EXT-003-B | change/delete 事件 | 正确检测 | 遗漏 | integration | P1 |
| EXT-003-C | 多项目监控隔离 | 独立触发,停一个不影响其他 | 监控泄漏 | integration | P2 |
| EXT-004-A | 内置 hermit-team-ops 包 | 含 16 workflow 作 commands,execution.type='loop-session' | 缺/类型错 | integration | P0 |
| EXT-004-B | 自定义包 import | 导入 `~/.hermit/capability-packs/`,commands/skills/workflows 注册 | 注册错 | integration | P1 |
| EXT-004-C | 包大小限制(>500 文件 / >20MB) | 拒绝并提示 | 未拒绝 | unit | P1 |
| EXT-004-D | 命令提示 >512KB | 拒绝并提示 | 未拒绝 | unit | P2 |

### [MCP-001/002] MCP Server 工具 / Global Context Packs
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| MCP-001-A | GET /mcp/tools | 含全部工具(name/description/inputSchema),SOCIETY_MCP_TOOLS 暴露 | 缺 | integration | P0 |
| MCP-001-B | POST /mcp/tools/{name} | 符合 schema 则执行,返回正确格式 | 调用错 | integration | P0 |
| MCP-001-C | society_register_worker / discover_workers | 注册后可发现 | 注册失败 | integration | P1 |
| MCP-001-D | society_publish_need / volunteer | 需求状态正确更新 | 状态错 | integration | P1 |
| MCP-002-A | 全局 context pack 加载 | `~/.hermit/global-context-packs/` 应用到所有会话 | 未应用 | integration | P2 |
| MCP-002-B | context 优先级 | 团队>项目>全局,同 key 覆盖 | 优先级错 | unit | P2 |

### [CLI-001] CLI Installer · [NOTIF-001] 通知
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| CLI-001-A | 零配置 onboarding | 首启未装 claude→显示安装引导 + 环境检测 | 引导未显 | manual | P0 |
| CLI-001-B | claude CLI 安装 | 下载正确版本 + 装对位置 + 命令可用 | 安装失败 | integration | P0 |
| CLI-001-C | 认证状态检测 | 正确解析 claude auth status,未认证→登录引导 | 状态错 | integration | P0 |
| CLI-001-D | claude-cli-auth-diag.ndjson | 生成 ndjson,>512KiB 截断为空 | 不生成/不截断 | unit | P1 |
| CLI-001-E | IPC getStatus 5s dedup | 5s 内返回缓存,不重复写 diag 行 | 重复写 | unit | P1 |
| NOTIF-001-A | 任务完成通知 | 触发 + 含任务信息 + 发对人 | 未触发 | integration | P1 |
| NOTIF-001-B | 需关注通知 | 触发 + 含原因 | 未触发 | integration | P1 |
| NOTIF-001-C | 错误通知 | 触发 + 含错误详情 | 未触发 | integration | P1 |
| NOTIF-001-D | 通知去重 | 快速重复触发被去重,不同通知独立 | 轰炸/误去重 | unit | P2 |

### [FEISHU-001] 飞书 / [WECHAT-001] 微信
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| FEISHU-001-A | /api/setup/feishu/begin | 返回授权 URL + redirect_uri + state(CSRF) | URL 错 | integration | P1 |
| FEISHU-001-B | /api/setup/feishu/poll | 授权成功→用户信息;中→pending | 状态错 | integration | P1 |
| FEISHU-001-C | /api/setup/feishu/save | 保存绑定 + persistPlatformRoutingMetadataForProject | 保存失败 | integration | P1 |
| FEISHU-001-D | 飞书消息路由 | 路由到对应团队 + agent 响应回飞书 | 路由错 | e2e | P1 |
| WECHAT-001-A~D | 微信 begin/poll/save/路由 | 同飞书对应项 | — | integration/e2e | P1 |

---

## 4. 渲染层 / 持久化 / 传输

### [UI-001~009] 核心 UI
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| UI-001-A | Dashboard 空状态 | 无团队→快速开始卡片 | 空白 | unit | P1 |
| UI-001-B | Dashboard 有团队 | 隐藏引导,显示最近项目 | 列表空 | unit | P1 |
| UI-002-A | TabBar 按钮渲染 | 团队/扩展/任务/社会/飞书按钮 | 缺 | unit | P1 |
| UI-002-B | 按钮点击导航 | 调对应 open 方法 | 不响应 | unit | P1 |
| UI-003-A | PaneContent 隐式根路由 `/` 无 tab | 显示 TeamListView | 空白 | unit | P1 |
| UI-003-B | 多 tab 切换 activeTabId | 正确切换内容 | 错乱 | unit | P1 |
| UI-003-C | SYSTEM_MANAGER_TEAM_NAME 路由 | 渲染 SystemManagerView | 错组件 | unit | P1 |
| UI-003-D | CSS display-toggle(切 tab 非激活 display:none 但 mounted) | DOM 保持 mounted | 卸载丢状态 | integration | P1 |
| UI-004-A | MentionableTextarea `@`/`#`/`/` 触发 | 各出对应候选列表 | 不触发 | unit | P0 |
| UI-004-B | 芯片原子光标导航 | 方向键原子跳芯片边界 | 光标进芯片内部 | unit | P0 |
| UI-004-C | 任务引用零宽元数据 | 蓝高亮 + 光标对齐 | 错乱 | unit | P0 |
| UI-004-D | 芯片 Backspace/Delete 整片删 + onChipRemove | 整片删 + 回调 | 残留半片 | unit | P0 |
| UI-004-E | Mod+Enter 提交(非 Shift) | 触发 onModEnter + 关提及框 | 不提交 | unit | P1 |
| UI-004-F | 芯片调和(粘贴/删除后) | chips 与文本 token 一致 | 不一致 | integration | P0 |
| UI-005-A | ExtensionStoreView 目录加载 | 挂载调 fetchPluginCatalog | 不调 | unit | P1 |
| UI-005-B | MCP 安装 | 点启用调 installMcpServer | 不调 | unit | P1 |
| UI-006-A | Settings 配置持久化 | 改配置刷新后正确恢复 | 丢失 | integration | P0 |
| UI-007-A | SystemManagerView workflow 执行 | 点执行调 IPC | 中断 | integration | P1 |
| UI-008-A | 代码编辑器 Git 状态徽章 | 有修改显示徽章 | 不显 | unit | P1 |
| UI-008-B | Git commit 集成 | 点提交调 Git commit IPC | 失败 | integration | P1 |
| UI-008-C | 二进制文件 | 显示"无法预览"提示 | 崩 | unit | P2 |
| UI-009-A | openTab/setActiveTab/closeTab | 正确增/切/删(tabSlice.test 已覆盖) | 错乱 | unit | P0 ✓ |
| UI-009-D | 拖拽 tab 重排/跨 pane | 顺序/归属正确更新 | 错乱 | integration | P1 |
| UI-009-E | pane 缩放(ResizeHandle) | 宽度更新 | 不变 | integration | P2 |
| UI-009-F | tab/pane 刷新后恢复 | layout + tab 状态恢复 | 丢失 | e2e | P1 |
| UI-010 | 团队列表卡片统计完整性(各团队 session/msg/token/耗时 独立) | 不同团队统计互不雷同、随各自活动实时增长 | 跨团队统计完全雷同/串数据(见 N-1) | e2e | P2 🔶待核实 |
| UI-011 | 团队名重复歧义 | 重名可区分或建时禁止 | 同名多条致歧义(见 N-2) | e2e | P3 🔶待核实 |

- **实测发现(gstack 巡检 2026-06-14,详见 `docs/测试用例/gstack-qa-report.md`)**:
  - **UI-003-A / N-4(P2)**:首屏 `/teams` 空白为**间歇性首屏竞态**,非必现(本轮一次 `goto /teams` 直接出内容)。原 F-1"必现空白"结论已修正。
  - **UI-003-B / N-3(P3)**:多 tab 下异常点击(失效 ref)触发选中态从"团队"漂到"Worker 社会"(`/society`),需复核 tab 焦点/路由竞态(亦可能 gstack ref 解析落到他 tab,需隔离)。

### [STORE/HOOKS] Zustand 与 Hooks（多数已覆盖）
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| STORE-001 | teamSlice(fetchTeams/getTeamData/kanban/messages/节流/工具审批/context 统计) | 各状态正确(teamSlice.test ✓) | 不一致 | unit | P0 ✓ |
| STORE-002 | tabSlice(open/close/switch/去重/导航)(tabSlice.test ✓) | 正确 | 错乱 | unit | P0 ✓ |
| STORE-003 | extensionsSlice(目录/MCP 安装/diagnostics/skills/toast)(✓) | 正确 | 状态泄露 | unit | P1 ✓ |
| STORE-004 | editorSlice(状态/gitStatus/文件树)(✓) | 切 tab 状态恢复 | 丢状态 | integration | P1 ✓ |
| HOOKS-001 | useExtensionsTabState(子tab/过滤/排序/清除)(✓) | 正确 | 错 | unit | P2 ✓ |
| HOOKS-002 | useMentionDetection(触发/坐标/键盘/选择/失效/IME)(✓) | IME 下 Enter 不提交 | 误提交 | integration | P0 ✓ |
| STORE-E1 | 跨 slice 一致性(team↔pane↔tab) | 同步 | 不一致 | integration | P1 |
| STORE-E2 | SSE 断线重连状态恢复 | 自动恢复 | 状态丢 | e2e | P1 |

### [PERSIST-001] 持久化分层 · [IPC-001] IPC 校验 · [FASTIFY-001] API · [SSE-001] · [CC-CONNECT-001]
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| PERSIST-A | paneLayout/tabUI/扩展/编辑器 持久化 | 各自正确保存恢复 | 丢 | integration | P0 |
| PERSIST-B | localStorage 不可用降级 | 内存态不崩 | 崩 | unit | P1 |
| PERSIST-C | 跨项目路径隔离 | 不互相污染 | 污染 | integration | P0 |
| PERSIST-D | schema 版本迁移 | 旧数据迁新格式 | 丢/错 | integration | P0 |
| IPC-A | createTask/sendMessage/installMcp 参数校验 | 非法→返回校验错误 | 不校验 | unit | P0 |
| IPC-B | 跨团队 targetTeam 不存在 | 降级为本地消息 | 崩 | unit | P0 |
| IPC-C | 路径越工作区 read | 拒绝读取 | 越权读 | unit | P0 |
| IPC-D | IPC 调用失败 | 返回安全默认不崩 | 崩 | unit | P0 |
| FASTIFY-A | GET /api/teams | 返回全部团队摘要 | 空/错 | integration | P0 |
| FASTIFY-B | POST /api/teams/create | 建团队返回详情 | 失败 | integration | P0 |
| FASTIFY-C | /api/cross-team/send | 路由到目标团队 | 路由错 | integration | P0 |
| FASTIFY-D | GET /api/health | 返回服务状态 | 不响应 | integration | P1 |
| FASTIFY-E | /api/collab/board | 返回协作板任务 | 错 | integration | P0 |
| SSE-A | broadcastSse | 所有订阅客户端收到 | 丢 | integration | P0 |
| SSE-B | 断线自动重连 | 重连恢复订阅 | 不重连 | e2e | P0 |
| SSE-C | 订阅清理(客户端断开) | 服务端清订阅 | 泄漏 | integration | P1 |
| CC-A | Bridge WS 连接 ws://127.0.0.1:9810 | 连接成功 | 连不上 | integration | P0 |
| CC-B | sendUserMessage 序列化(中文/特殊字符) | 正确序列化不解码 | 乱码 | unit | P1 |
| CC-C | 3s 自动重连 + 30s ping | 重连 + 心跳 | 断不重连 | integration | P0 |
| CC-D | cc-connect 未启 → 直连 CLI 降级 | 优雅降级 | 崩 | e2e | P0 |

### [E2E-001] Web 模式（Electron↔Fastify 双形态,当前 0 覆盖）
| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 |
|---|---|---|---|---|---|
| E2E-A | Web 模式启动 | Fastify 正常运行 | 起不来 | e2e | P0 |
| E2E-B | Web UI 建团队 | 建好并同步到 server | 不同步 | e2e | P0 |
| E2E-C | Web UI 发消息经 SSE 实时推送 | 实时收到 | 丢 | e2e | P0 |
| E2E-D | Web UI 拖看板卡片 | 状态更新 | 不更新 | e2e | P1 |
| E2E-E | Electron 与 Web 同操作结果一致 | 完全一致 | 不一致 | e2e | P0 |
| E2E-F | Web SSE 断线重连 | 自动重连恢复订阅 | 不重连 | e2e | P0 |
| E2E-G | Web 跨团队消息 A→B | 正确路由 | 路由错 | e2e | P0 |

---

## 5. 覆盖现状 / 缺口 / 优先级

### 5.1 现有测试总览
- 测试文件 ~265 个(vitest),renderer 层最多(~185)。
- 工具链:vitest 3.1.4 + happy-dom + @vitest/coverage-v8 + playwright(已装但**无 config/无 .spec**)。
- CI 配置:`vitest.ci.config.ts`(lines 65%/functions 75%/branches 60%)、`vitest.critical.config.ts`(含 stallMonitor)。
- ⚠️ CLAUDE.md 提及的 `test:coverage:critical / test:chunks / test:semantic / test:noise / test:task-filtering` 部分在 package.json 未定义,需核实。

### 5.2 覆盖地图
| 功能域 | 覆盖 | 关键缺口 |
|---|---|---|
| teams-mvp / 跨团队协作 | 部分 | 端到端启动流程、relay 循环、appendMessage ID 传播集成 |
| 会话-chunk-上下文 | 充分(基础) | 6 类上下文注入、compaction 处理、subagent 匹配(高级) |
| system-manager-loop-workflow | 部分 | workflow 执行端到端、循环命令边界 |
| extensions-mcp | 部分 | MCP 连接稳定性、扩展加载失败恢复 |
| renderer-ui-store | 充分 | MentionableTextarea 交互、拖拽/缩放 |
| persistence | 薄弱 | IndexedDB 回滚、数据迁移、降级 |
| transport-ipc-server | 薄弱 | IPC 重连、server 崩溃恢复 |
| cli-auth-onboarding | 薄弱 | CLI 安装端到端、认证失败 |
| e2e(playwright) | **空白** | 无 config、无 .spec、无脚本 |

### 5.3 CLAUDE.md 历史回归点核对
| 回归点 | 测试? | 文件 |
|---|---|---|
| message pipeline(teamMessageKey) | ✅ | teamMessageKey.test.ts |
| mergeTeamMessages 去重 | ✅ | mergeTeamMessages.test.ts |
| teamMessageFiltering | ✅ | teamMessageFiltering.test.ts |
| appendMessage ID 传播 | ⚠️ 部分 | TeamWorkspaceService.test.ts |
| relay 循环(relayMemberInboxMessages) | ❌ | — **必补** |
| duplicate messages | ⚠️ 部分 | teamMessageFiltering.test.ts |
| silent restart | ❌ | — **必补** |

### 5.4 Top 补测优先级
- **P0 必补**:relay 循环回归、appendMessage ID 传播集成、跨团队消息端到端、IPC 参数校验、Fastify/SSE 契约、Web 模式 e2e、持久化迁移、MentionableTextarea 芯片调和、6 类上下文注入、compaction 重置。
- **P1**:团队启动端到端、CLI 认证端到端、MCP 连接稳定、拖拽/缩放、silent restart。

### 5.5 e2e 基础设施(当前最大空白)
- 建 `playwright.config.ts`、`test/e2e/` 目录、package.json `test:e2e` 脚本。
- 首批场景:团队创建、看板更新、跨团队消息、CLI 认证、Web 模式。

---

## 6. Worker Society 插件 · 去中心化自治（SOCIETY-*）

> hermit 自带的去中心化 worker 自治社会（取代集中式派单）。完整用例表（每条含场景/验收/类型/优先级/现有测试映射）见
> **[`worker-society.md`](./worker-society.md)**（本节为 agent 可执行的 runbook 入口）。
> 代码：`src/features/worker-society/`；现状：**12 测试文件 / 207 用例 / 全绿**。

### 6.1 闭环（黄金路径）
```
publishNeed(open) → volunteerFor(自荐,FitScore) → selectAssignee(择优,assigned)
  → startNeed(in_progress) → deliverNeed(delivered) → acceptDelivery(closed)
  ⟶ 声誉 +、Relationship 累积、Feed 跨团队格式化
```
旁路：cancelNeed→cancelled · requestRevision→assigned(revisionCount+1) · expireNeeds→expired。
一键自治：「触发自治」= `runAutonomyTick()`（贪婪自荐，双向配额）+ `autoSelectPending()`（择优）。

### 6.2 域用例总览（详见 worker-society.md）
| 域 | 覆盖 | 关键文件 | 现有测试 |
|---|---|---|---|
| SOCIETY-001 worker 注册/发现 | ✅ | societyPolicies/service | ✅ |
| SOCIETY-002 Need 全生命周期 | ✅ | transitionNeed/service | ✅ |
| SOCIETY-003 去中心化自治 | ✅ | autonomousVolunteers | ✅ |
| SOCIETY-004 声誉/关系累积 | ✅ | applyReputationDelta/recordCollaboration | ✅ |
| SOCIETY-005 消息/Feed | ⚠️ | sendSocialMessage/gateway | ✅（倒序/边界未测） |
| SOCIETY-006 图谱投影 | ✅ | societyGraphAdapter | ✅ |
| SOCIETY-007 视图工具 | ✅ | societyViewUtils | ✅ |
| SOCIETY-008 REST `/api/society/*` | ✅ | societyRoutes（19 路由） | ✅ |
| SOCIETY-009 MCP `society_*` | ✅ | societyMcp（13 工具） | ✅ |
| SOCIETY-010 可安装插件 | ⚠️ | workerSocietyPlugin + `agentpanel add` | ✅ unit / ⚠️ e2e 人工 |
| SOCIETY-011 持久化 | ✅ | fsStores | ✅ |
| SOCIETY-012 组合根/渲染挂载 | ⚠️ | composition/SocietyGraph/SocietyView | ✅ 逻辑 / ❌ UI 未测 |

### 6.3 agent 执行命令
```bash
# 1) 全量（worker-society 独立、秒级）
node_modules/.bin/vitest run src/features/worker-society
# 2) 关键路径速查
node_modules/.bin/vitest run \
  src/features/worker-society/core/domain/policies/societyPolicies.test.ts \
  src/features/worker-society/main/adapters/input/societyRoutes.test.ts \
  src/features/worker-society/main/adapters/input/societyMcp.test.ts
# 3) 类型（worker-society 应为空；ClaudeDoctorProbe 的 3 个错误是环境基线，与本插件无关）
node_modules/.bin/tsc -p . 2>&1 | grep worker-society
# 4) Web 形态冒烟（黄金路径）
pnpm dev:server & pnpm dev:web &
curl -s http://127.0.0.1:5680/api/society/workers
curl -s -XPOST http://127.0.0.1:5680/api/society/autonomy/tick
curl -s http://127.0.0.1:5680/mcp/tools/list | grep society_   # 应见 13 个
```

### 6.4 判定与报告（沿用全局格式）
- 每条用例执行后输出：`[SOCIETY-xxx-yyy] PASS|FAIL|SKIP  实际现象（FAIL 附证据）`。
- **业务错误**：状态机非法跳变须返回 HTTP 200 + `{ok:false,error}`（非 5xx）。
- **回归红线**（破坏即阻塞）：非法跳变业务错误、声誉 clamp[0,100] 不重复累加、配额计数含已有自荐者、图谱投影确定性、avatar 稳定映射。

### 6.5 已知缺口（优先补）
- ❌ React 组件挂载（SocietyGraph 全屏 / 空状态引导 / 全屏铺满 / 实时重投影）：需 @testing-library/react 或 playwright。
- ⚠️ 插件 `agentpanel add` 端到端自动化（POST /api/extensions/mcp/library + 临时 HOME）。
- ⚠️ feed 倒序单测、收件人不存在边界。

---

## 附录 A:执行入口(给 agent 的最小启动集)
```bash
pnpm install
pnpm test:coverage:critical 2>&1 | tail -30   # 关键路径先行
pnpm typecheck 2>&1 | tail -20
# 针对 P0 回归:
pnpm vitest run test/renderer/utils/mergeTeamMessages.test.ts test/renderer/utils/teamMessageFiltering.test.ts
# 跨团队派单 API 烟测(web 模式):
pnpm dev:server &  pnpm dev:web &
curl -s http://127.0.0.1:5680/api/health
curl -s http://127.0.0.1:5680/api/collab/board | head -c 300
```

## 附录 B:验收标准速查
- **API 用例**:HTTP 状态 + JSON 字段 + 业务状态流转(非法跳变必须返回 ok:false 业务错误,非 5xx)。
- **状态机用例**:每步打印 before→after status + version + revisionCount。
- **回归用例**:断言"无重复消息 / 无 relay 循环 / ID 不被重生成"。
- **e2e 用例**:断言 UI 可见元素 + 截图留证 + console error=0。

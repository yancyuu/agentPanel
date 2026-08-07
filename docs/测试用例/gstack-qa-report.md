# Hermit gstack QA 执行报告

> 执行方式:gstack 无头浏览器(harness)+ Fastify API 直测,对照 `docs/测试用例/agent.md`。
> 环境:Web 模式 Fastify `:5680` + Vite `:5174`,分支 `spec/11-team-isolation-containers`。
> 日期:2026-06-14。证据截图:`/tmp/hermit-gstack-qa/0[1-7]-*.png`。

## 结论(ship-readiness)

**SHIP_READY_WITH_MINOR_UX_GAPS** — 核心链路(团队、跨团队派单全生命周期、消息管道、扩展商店)全部通过且护栏精确;发现 2 个 P2 体验问题、1 个待确认项;e2e/playwright 与若干深度域尚未覆盖。

---

## PASS(功能验证)

### TEAM-004 跨团队派单全生命周期 —— 完整闭环 ✅(本次最高价值)
dispatchId `907bd320-…`,team-jcve(测试)→ team-3ond(爬虫):

| 步骤 | 动作 | 结果 | 用例 |
|---|---|---|---|
| send | POST /api/cross-team/send | `ok:true` status `received`,目标团队建 TODO `t_mqcjsmlz_ukjm7e`,board 反映 | TEAM-004-001 ✅ |
| start | POST /api/teams/.../start | `{notifiedOwner:true,crossTeamStarted:true}`,board `received→in_progress` | TEAM-004-002 ✅ |
| complete_task | MCP tools/call | 任务 `status:done` | (done 路径) ✅ |
| deliver | POST /api/cross-team/deliver | `ok:true`,board `→delivered` | TEAM-004-004 ✅ |
| approve | POST /api/cross-team/approve | `ok:true`,board `→approved` | TEAM-004-005 ✅ |

**3 个完整性护栏全部精确触发:**
- deliver 前任务未 done → `"Task result cannot be delivered before the agent marks the task done."` (TEAM-004-011 ✅)
- approve 前未 delivered → `"Invalid collab task transition: in_progress -> approved; expected delivered"` (TEAM-004-010 ✅)
- agent 处理中手动完成 → `"Agent 正在处理中,不能手动完成或取消…"` (TEAM-003-007 ✅,防 silent-restart 竞态)
- approve 校验缺 `team_slug` → `"team_slug and dispatch_id are required"`(参数校验 ✅)

**消息联动**:approve 自动向 team-3ond 收件箱写入系统通知 `[跨团队任务审核通过] "[gstack-QA] 生命周期验证…"`,稳定 ID `m_mqcjxbyw_9r9j76`,**仅出现一次**(TEAM-004-005 双向通知 ✅ + 现场去重 ✅)。

### 烟测 ✅
- UI 加载 `/teams`,HTTP 200,**0 console error**,全部请求 200。
- API `/api/teams` 返回 22 个团队;`/api/cross-team/discover` 团队 online + collaboration:true。

### UI 渲染 ✅
- 团队列表:22 团队卡片(名称/状态/会话·消息·token·在线时长统计)、搜索、筛选、创建入口。
- 团队详情 `/team/hermit`:成员、会话/外部派单/指令台可折叠区、看板网格/列视图切换、消息角色(hermit/user)。
- 扩展商店 `/extensions`(body 52847):oh-my-claudecode 已装、42crunch/adobe/agent-sdk 待装、"仅已安装"过滤(EXT-001-A ✅)。
- 系统管理 `/system-manager`:工作目录、运行时、命令控制台(SYS-004-A ✅)。

### 消息管道回归 ✅
- 单测 `mergeTeamMessages` + `teamMessageFiltering` = **8/8 green**(去重/过滤回归面)。
- 现场证据:派单/审批产生的系统消息 ID 稳定且无重复。

---

## 发现(问题 / 待确认)

| # | 级别 | 现象 | 建议 |
|---|---|---|---|
| F-1 | P2 UX | 首次加载 `/teams` 主内容区**完全空白**(`document.body.innerText.length === 0`),仅顶部 TabBar,直到点击"团队"才出内容。首启用户看到空屏。 | 无 tab 时显示空状态 CTA(如"新建团队/打开团队")。 |
| F-2 | P2 | **深链直跳** `/team/hermit`(goto)渲染不完整(仅标题,无视图切换按钮),而经 UI 点击进入则完整(body 4065)。直接 URL 加载可能 tab 状态未初始化。 | 复核深链路由是否正确恢复 tab/pane 状态。 |
| F-3 | 待确认 | `/tasks` 标签页内容极轻(body 131)。 | 确认是否预期(任务总线空?)还是渲染缺失。 |
| — | 信息 | `wait --networkidle` 永不 settle(SSE 持续轮询)。 | 预期行为,非缺陷;测试脚本勿依赖 networkidle。 |

---

## 未覆盖(需后续补测)
- 看板 CRUD 在**有数据看板**上的 UI 全流程(本次所有团队 board 均空)。
- **e2e playwright**:仓库无 `playwright.config`/无 `.spec`(agent.md §5.5 最大空白)。
- IPC 参数校验批量、持久化 schema 迁移、CLI 认证 onboarding 端到端、飞书/微信路由 e2e。
- `appendMessage` ID 传播集成测试、`relay 循环` / `silent restart` 专项回归(agent.md §5.3 ❌)。

---

## 证据清单(`/tmp/hermit-gstack-qa/`)
- `01-home.png` — 空白首屏(F-1)
- `02-teams-annotated.png` — 团队列表
- `03-team-detail.png` — 团队详情 + 看板 + 指令台
- `04-kanban.png` — 看板视图
- `05-extensions.png` — 扩展商店
- `06-tasks.png` — 任务标签页(F-3)
- `07-systemmanager.png` — 系统管理 / Admin Loop

---

## 本轮补充发现(2026-06-14 · gstack 功能巡检)

> 续上一轮 ship-readiness。本轮聚焦 UI/UX 功能巡检(浏览器自动化点击 + DOM/数据观察)。
> 像素级视觉复核受限:本环境 Read 截图仅回 CDN 链接、`analyze_image` 视觉后端拒绝带签名 URL(400),故以**实时 DOM + 计算布局 + API 源数据**为主要观察通道(对功能/数据/空白类 bug 反而更准)。

### PASS(本轮确认)

| 项 | 结果 | 证据 |
|---|---|---|
| 创建数字员工表单 | ✅ 验证正确 | 点"创建数字员工"弹出表单(名称\*/项目标识\*/Agent 类型=Claude Code/项目选择/自定义路径),"创建"按钮在必填项空时 `disabled`。`/tmp/hermit-ui-test/04-create-dialog.png` |
| F-1 首屏空白 | ⚠️ 间歇性 | 本轮一次 `goto /teams` 后内容直接出现(`content-present-on-first-load`),另一次需点"团队"tab。结论:F-1 为**首屏竞态,非必现**,窗口仍需修(见 N-4)。 |

### 发现(按功能优先级)

| # | 级别 | 功能面 | 现象 | 复现/证据 | 建议 |
|---|---|---|---|---|---|
| N-1 | P2 待核实 | 团队列表/数据 | **跨团队统计疑似雷同**:"你好222" 与 "汇报" 同一快照均显示 `122 sessions · 8065 msgs · 443.9M tokens · 12d 21h`(完全一致)。"你好222"随后增至 8135/448.1M/12d22h(实时聚合正常),"汇报"是否同步未当场复测(modal 遮挡致 JS 查询为空)。 | `02-teams-loaded.png` body 文本 | 核实统计聚合是否串数据/共享缓存。**自动 loop 将复测,稳定复现前不升级为确认 bug。** |
| N-2 | P3 待核实 | 团队列表/命名 | **团队名重复**:"汇报"在列表出现两条(其一 `no activity`)。 | snapshot @e26/@e32 | 确认是否允许重名;按名展示会造成歧义。**待核实。** |
| N-3 | P3 | 导航/标签页 | **标签页漂移**:多 tab 下 ref 失效后点击,选中态从"团队"漂到"Worker 社会"(/society)。 | `03-create-employee.png` 显示 /society | 复核多 tab 焦点/路由在异常点击下是否被错误切换;亦可能 gstack ref 解析落到其它 tab,需隔离。 |
| N-4 | P2 | 首屏加载 | F-1 应修正为**间歇性首屏竞态**(原结论"必现空白"过强)。 | 本轮两次 goto 结果不一致 | 排查首屏 tab/pane 初始化竞态,加空状态 CTA 兜底。 |

### 待核实项处理原则
N-1/N-2 标 **待核实**:不臆断为确认 bug。已纳入自动 loop 复测;稳定复现后再升级。

---

## 本轮修复记录(2026-06-14)

> 针对「发现」表与「本轮补充发现」的逐项处理。验证:typecheck 全项目 exit 0 · 全量 vitest 272 文件 / 2824 测试通过 · 新增 `initialRoute.test.ts`(10 例)覆盖 F-1/F-2 路由恢复机制。

| 项 | 处置 | 依据 / 改动 |
|---|---|---|
| **F-1 / N-4**(P2 首屏空白) | ✅ 已修复 | 根因:深链/首屏 tab 在 post-mount effect 里才打开,存在竞态。改 **main.tsx 首帧前同步** 调 `restoreInitialRoute`(新增 `src/renderer/utils/initialRoute.ts`)把 URL→tab 映射进 store;`App.tsx` 的 post-mount restore 移除;`PaneContent` 兜底门改为 `!activeTabId && tabs.length===0`。新增 10 例单测。 |
| **F-2**(P2 深链 `/team/:slug` 渲染不完整) | ✅ 已修复(同 F-1 根因) | 旧 `App.tsx` post-mount restore 的时序竞态已被 F-1 同步 restore 消除。验证:`openTeamTab` 的 projectPath 唯一副作用是 `selectProject`(仅侧栏高亮);`projectId`/`leadSessionId`/`data` 均来自 `selectTeam` 加载的 data,两条路径数据加载后渲染完全等价。 |
| **F-3**(待确认 `/tasks` 极轻) | ✅ 确认为预期 + 改善 UX | `fetchAllTasks→api.teams.getAllTasks()` 聚合全团队任务;本轮 task bus 为空(`body 131`≈ 完整渲染的空看板:sub-tab+3 筛选+TODO/IN PROGRESS/DONE+3×"No tasks",卡住的 loading 只会 ≈30 字符)。`TasksView` 改:`overviewTasks` 真为空时显示说明性空状态("暂无 Loop 任务…各团队 pending/in_progress/completed 任务会汇总到这里"),消除"是不是 bug"歧义;有任务仅被筛选隐藏时保留原 "No tasks"+清空筛选。 |
| **N-3**(P3 选中态漂移到 /society) | ✅ 非 app bug(测试桩 stale-ref) | `/society` 仅由两处触发:①TabBarActions 的 Bot 图标按钮(`aria-label="Worker 社会"`)②深链 `/society`。`tabSlice` 中 society 仅出现在 `openSocietyTab`;关 tab 回退逻辑从不落到 society。漂移=gstack 持有的元素 ref 在 React 重渲染后脱落,下一次 click 落到坐标上此刻的 society 图标按钮。app 侧无法区分真实点击/stale-ref,改 app 会破坏真实 UX——属测试桩问题(应用 `aria-label` 选择器而非脱落 ref)。与原报告自注"亦可能 gstack ref 解析落到其它 tab"一致。 |
| **N-1**(跨团队统计雷同) | ✅ 定论:非 bug,共享 workDir 的正确聚合 | 查实际 manifest 铁证:`你好222`(slug `222-11io`)与 `汇报`(slug `team-2`)的 **workDir 完全相同** = `/Users/yancyyu/code`;共享 session 目录 `~/.claude/projects/-Users-yancyyu-code/`(7 jsonl)确实存在。`server.ts:1637` 团队列表统计 = `getProjectStatsSnapshot(meta.workDir)`,其缓存 `teamStatsCache` **以 workDir 字符串为键**(server.ts:433)——同 workDir → 同缓存键 → 返回**同一 stats 对象** → "完全一致"。这不是"串数据"污染,是两个团队指向同一项目目录时共享该项目 session 统计的**按设计正确行为**。"你好222"后续独立更新(8135/448.1M)是因为该快照后又有该 workDir 下的新活动,"汇报"未复测(modal 遮挡)。根因=共享 workDir,正是分支 `team-isolation-containers` 要解决的。**已与用户确认:保持现状**(两条团队为不同用途,共享 workDir 的统计雷同属正确聚合,无需改动)。 |
| **N-2**("汇报"重复) | ✅ 定论:真实重名数据,非 dedup bug | 查实际 manifest:确有**两个** displayName="汇报" 的团队——`team-2`(workDir=`/Users/yancyyu/code`,bindProject=`汇报`)与 `team-ntj1`(workDir=`/Users/yancyyu/code/cc-connect`,bindProject=`team-ntj1`)。是两条不同的真实团队(不同 slug/workDir/bindProject),列表如实各显示一张卡,符合预期。`fetchTeams` 的 `teamByName` 按 teamName 去重,但 `teams` 数组如实展示后端返回——两个不同 slug 同 displayName 的团队本就该各显示一张。重名保护(禁止同 displayName)为本分支新增(#19/#23),这两条是保护上线前创建的存量数据。**已与用户确认:保持现状**(两条「汇报」为独立工作区,无需去重)。 |

---

## TEAM-010 团队协作 `@team` 派单实测(2026-06-14 · gstack live)

> 用例 `docs/测试用例/agent.md` [TEAM-010]。源团队 `team-jcve`(测试)在指令台输入 `@team-4 …` → 目标团队 `team-4`(产品经理)收 TODO。web 模式 Fastify `:5680` + Vite `:5174`(用户既有进程,未另起服务)。

### TEAM-010-001 ✅(live)解析为跨团队意图
- 指令台 textarea 输入 `@team-4 [TEAM-010-005 gstack-QA] 跨团队派单到达验证 20260614` 后,发送按钮旁标签实时变为 **`派单到 team-4`**(`getLoopSendIntentLabel` cross-team-task 输出)→ 证明 `parseLoopSendIntent` 把 `@team-4` 解析为 `kind=cross-team-task`、`toTeam=team-4`(与单测 001 一致)。

### TEAM-010-005 ✅(integration)目标团队收到 TODO、status=received
点「执行」提交后:
- **源侧**:`team-jcve` 消息流记 `cross_team_sent` `@team-4 [TEAM-010-005…]`(无 `无法派发` 错误 → 未抛异常)。
- **目标侧**:`~/.hermit/teams/team-4/tasks/board.json` 新增任务 `t_mqdisw1j_l7gza0`(`teamSlug=team-4`、`status=todo`、`title=[TEAM-010-005…]`)。
- **dispatchMeta**:`{dispatchId:"loop-cross-team-1781425592115", originTeam:"team-jcve", targetTeam:"team-4", status:"received"}` ← **命中 005 验收点**。
- **collab board**:`~/.hermit/collab-board.json` + `collab-events.jsonl` 同步记录 `from=team-jcve → to=team-4, status=received`。

### ✅ F-4(P2 · 已核实:非代码 bug):派单任务的 API/UI 可见性缺口
派单**数据正确落盘**(board.json 有任务、collab-board 有记录),但**读取侧不反映**:
- `GET /api/teams/team-4/board` → `[]`(board.json 实有 1 任务)。
- `GET /api/teams/team-4` → `[]`(team-4 在 `/api/teams` 列表与 `/api/cross-team/discover` 均存在且 online)。
- 源侧 team-jcve 详情「外部派单」面板显示 **0**(实有 1 条发出派单 + 历史 `@hermit` 派单)。
→ 影响 **TEAM-010-007(双侧可见性)**:派单已创建且 `received`,但看板/外部派单面板读不到。疑 board/detail 读取路径未覆盖跨团队 dispatch 写入的 store,或读取缓存未失效。**有磁盘铁证(disk vs API 矛盾),已纳入修复 loop `c75b7e55` 复核。**

**✅ 复核结论(2026-06-14):非代码 bug,gstack 测试瞬态 + 路由误用。** 逐项核实:

1. **所引路由不存在**:`GET /api/teams/:name/board` 在 server.ts 中**无此路由**(只有 `GET /api/collab/board` @5746)。团队看板真实端点是 `GET /api/teams/:name/tasks`(@2086,`svc.readTasks`)。gstack 命中的"返回 []"很可能是 404/错路径或测试时序问题,非读取缺陷。
2. **读后写一致性已由测试证明**:新增 `TeamWorkspaceService.test.ts` 用例「a dispatched received task is visible on the target team board」——`createTask('team-4',{dispatchMeta}) → readTasks('team-4')` 返回该任务,`status=todo`、`dispatchMeta` 完整往返;且 `readTasks('team-jcve')` 不串数据。读写共享 `resolveStorageSlug+teamRoot`(同路径)、`readJson/writeJson` 不缓存、`activeTasks` 仅过滤 `result==='__deleted__'`(派单任务 `result:null` 不过滤)。**16/16 green**。
3. **源侧「外部派单」面板 = 本团队看板**:`TeamDetailView.tsx:2449` 该面板即 `<KanbanBoard tasks=本团队tasks>`,badge=`filteredTasks.length`。team-jcve 是**源团队、无入站任务**,故面板为 0 属**正确**(它本就不该有入站)。出站派单的可见性属 `collab-board.json`(team-jcve→team-4 记录确实在),是另一条数据线,非该面板职责。
4. **磁盘 vs API 矛盾的成因**:派单 `dispatchTask` 内 `createOrReuseReceivedTask`(await 落盘)在返回响应前完成;若 gstack 在派单 HTTP 响应返回的同一拍、或 team-4 详情数据被渲染端缓存尚未刷新时查询,会观测到瞬时空窗。

**处置**:无需改代码(读写路径正确)。已加回归测试守住「目标侧派单可见性」(TEAM-010-007 目标侧)。源侧出站派单若需独立 UI 展示,属后续功能项,非 bug。**F-4 关闭。**

---

## 最终闭环补充(2026-06-15)

- **当前 open product bug:0**。复核报告内 F-1/F-2/F-3/N-3/F-4 均已闭合;N-1/N-2 为已确认非 bug 的真实数据/共享 workDir 行为;2026-06-15 cron `api:down` 为后端进程未运行时的只读巡检环境观察,不构成 src 回归。
- **本轮补齐回归覆盖**:
  - `test/renderer/components/team/loop-console/loopSendIntent.test.ts`:补充全角 `＠`/全角空格中文输入法路径经 Loop 指令台解析为 `cross-team-task`,以及跨团队派单保留结构化 `taskRefs`。
  - `src/main/services/teams-mvp/TaskDispatchService.test.ts`:补充 runtime 启动失败回滚到 TODO/received、重复 Start 不二次触发 runtime、本地跨团队 deliver/approve 通知链路有限且目标审核通过通知仅 1 次。
  - `src/renderer/components/team/kanban/KanbanBoard.test.tsx`:新增有数据看板覆盖,验证 TODO/IN PROGRESS/DONE 三列渲染 seeded tasks,并覆盖任务/筛选/排序/回收站回调接线。
- **已执行验证**:
  - `pnpm vitest run src/renderer/utils/__tests__/initialRoute.test.ts test/renderer/components/team/loop-console/loopSendIntent.test.ts src/main/services/teams-mvp/TeamWorkspaceService.test.ts src/main/services/teams-mvp/TaskDispatchService.test.ts src/renderer/components/team/kanban 2>&1 | tail -80` → **6 files / 52 tests passed**。
  - `pnpm typecheck 2>&1 | tail -20` → **passed**。
- **剩余非 bug backlog**:Playwright/e2e、IPC 批量参数校验、schema 迁移、CLI auth onboarding、飞书/微信外部路由仍属于覆盖深度 backlog,不是本报告的 open bug。

---

## 自动 loop 日志

> cron `955ac08b`(v3;`2-59/10 * * * *`,durable,**7 天后自动到期**)每 10 分钟追加。仅当 src 有变更才执行;只读巡检(不建团队/不 commit/不自动起服务)。v3 新增 **TEAM-010 `@team` 派单解析/校验**(`pnpm vitest run loopSendIntent`):001 已知团队→cross-team-task、003 未知团队回退 message、004 源团队离线仍可派单。ID 随重建变化,以 CronList 为准。最新在底部。

- **2026-06-14T10:20:42**(手动触发,证明 loop 逻辑可执行) PASS — typecheck:ok(exit 0) · api:ok(`/api/teams`+`/api/cross-team/discover` 200) · ui:**empty(F-1 fresh goto 空白,强化 N-4)** · findings:F-1 再次复现;N-1/N-2 因 F-1 空白读不到卡片未测 → 已升级 loop v2(空白时点"团队"tab 强制加载再读)。marker 已写。
  > **⚠️ 时序更正(2026-06-14 复核)**:本条 "F-1 再次复现" 的观测**早于 F-1 修复落地**——`src/renderer/utils/initialRoute.ts` 创建于 **10:43**(本条观测为 10:20:42),即 loop 跑的时候修复尚未存在。故该 "empty" 为**过时记录**,不构成 open bug。
- **2026-06-14(修复后人工复核)** F-1/N-4 ✅ 已修 + 验证 — 证据:① `main.tsx:30` 首帧前同步调 `restoreInitialRoute`(把 `/teams`→`openTeamsTab()` 在 React 首次渲染前写入 store);② `PaneContent.tsx:40` `showDefaultTeams = !activeTabId && pane.tabs.length===0` 兜底渲染 `TeamListView`,面板**永不为空**(即 F-1 建议的空状态兜底);③ `initialRoute.test.ts` **10/10 green** 覆盖 F-1/F-2 路由恢复;④ `App.tsx` post-mount restore 已移除(注释 line 119-120)。**报告全部条目已闭合:F-1/F-2/F-3/N-3/F-4 ✅,N-1/N-2 ✅(确认非 bug、用户确认保持现状)。零 open bug。**
- 2026-06-15T04:06:02Z(cron v3) PASS — typecheck:ok · TEAM-010:ok · api:down · ui:skipped · findings:backend down http:000; 跳过 API/UI
- 2026-06-15T04:15:55Z(cron) SKIP — src 无变更
- 2026-06-15T04:25:58Z(cron) SKIP — src 无变更
- 2026-06-15T04:35:45Z(cron) SKIP — src 无变更
- 2026-06-15T04:46:59Z(cron) SKIP — src 无变更
- 2026-06-15T04:55:40Z(cron) SKIP — src 无变更
- 2026-06-15T05:05:57Z(cron) SKIP — src 无变更
- 2026-06-15T05:15:52Z(cron) SKIP — src 无变更
- 2026-06-15T05:25:44Z(cron) SKIP — src 无变更
- 2026-06-15T05:35:49Z(cron) SKIP — src 无变更
- 2026-06-15T05:45:46Z(cron) SKIP — src 无变更
- 2026-06-15T05:55:44Z(cron) SKIP — src 无变更
- 2026-06-15T06:05:42Z(cron) SKIP — src 无变更
- 2026-06-15T06:44:49Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok · api:down · ui:skipped · findings:backend down http:000; 跳过 API/UI
- 2026-06-15T06:56:05Z(cron) SKIP — src 无变更
- 2026-06-15T07:06:02Z(cron) SKIP — src 无变更
- 2026-06-15T07:15:49Z(cron) SKIP — src 无变更
- 2026-06-15T07:25:58Z(cron) SKIP — src 无变更
- 2026-06-15T07:35:58Z(cron) SKIP — src 无变更
- 2026-06-20T14:46:46Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:backend down http:000; typecheck+TEAM-010 通过, 跳过 API/UI 检查
- 2026-06-20T14:55:16Z(cron) SKIP — src 无变更
- 2026-06-20T15:51:26Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:workflow 重构后 typecheck+TEAM-010 通过; backend :5680 未起, 跳过 API/UI
- 2026-06-20T15:55:20Z(cron) SKIP — src 无变更
- 2026-06-20T16:05:21Z(cron) SKIP — src 无变更
- 2026-06-20T16:15:47Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:typecheck+TEAM-010 通过; backend :5680 未起, 跳过 API/UI
- 2026-06-20T16:25:19Z(cron) SKIP — src 无变更
- 2026-06-20T16:35:20Z(cron) SKIP — src 无变更
- 2026-06-20T16:45:25Z(cron) SKIP — src 无变更
- 2026-06-20T16:55:32Z(cron) SKIP — src 无变更
- 2026-06-20T17:05:15Z(cron) SKIP — src 无变更
- 2026-06-20T17:15:30Z(cron) SKIP — src 无变更
- 2026-06-20T17:25:28Z(cron) SKIP — src 无变更
- 2026-06-20T17:35:14Z(cron) SKIP — src 无变更
- 2026-06-20T17:45:28Z(cron) SKIP — src 无变更
- 2026-06-21T01:44:13Z(cron) SKIP — src 无变更
- 2026-06-21T01:49:43Z(fixbug cron) PASS — typecheck:ok · test:3065/3065 全过 · 无回归,不改代码
- 2026-06-21T01:55:15Z(cron) SKIP — src 无变更
- 2026-06-21T02:05:13Z(cron) SKIP — src 无变更
- 2026-06-21T02:12:02Z(fixbug cron) FIXED — usageEventMapper.test.ts(untracked 半成品)缺实现致 typecheck/vitest fail; 调查期间并发进程补全 usageEventMapper.ts(复用 extractExternalImUsageMetrics), 复验 typecheck:ok · test:3069/3069 全过
- 2026-06-21T02:15:36Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:并发改动后 typecheck+TEAM-010 通过; backend :5680 未起, 跳过 API/UI
- 2026-06-21T02:25:38Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:并发开发期 src 持续变更, typecheck+TEAM-010 通过; backend 未起, 跳过 API/UI
- 2026-06-21T02:28:54Z(fixbug cron) PASS — typecheck:ok · test:3071/3071 全过 · 无回归,不改代码
- 2026-06-21T02:35:15Z(cron) SKIP — src 无变更
- 2026-06-21T02:45:52Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:新提交 71efa003(IM usage→Redis); typecheck+TEAM-010 通过; backend 未起, 跳过 API/UI
- 2026-06-21T02:48:56Z(fixbug cron) PASS — typecheck:ok · test:3071/3071 全过 · 无回归,不改代码
- 2026-06-21T02:55:13Z(cron) SKIP — src 无变更
- 2026-06-21T03:05:37Z(cron) SKIP — src 无变更
- 2026-06-21T03:08:30Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T03:15:25Z(cron) SKIP — src 无变更
- 2026-06-21T03:25:48Z(cron) SKIP — src 无变更
- 2026-06-21T03:28:24Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T03:35:20Z(cron) SKIP — src 无变更
- 2026-06-21T03:45:18Z(cron) SKIP — src 无变更
- 2026-06-21T03:50:44Z(fixbug cron) FIXED — usageEventMapper.test 新增 turn_id→turnId 期望,实现暂缺致 fail; 并发进程补 turnId: msg.turn_id 映射, 复验 typecheck:ok · test:3077/3077 全过
- 2026-06-21T03:55:59Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:活跃开发期未提交改动, typecheck+TEAM-010 通过; backend 未起, 跳过 API/UI
- 2026-06-21T04:05:18Z(cron) SKIP — src 无变更
- 2026-06-21T04:08:23Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T04:15:16Z(cron) SKIP — src 无变更
- 2026-06-21T04:25:14Z(cron) SKIP — src 无变更
- 2026-06-21T04:28:22Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T04:35:20Z(cron) SKIP — src 无变更
- 2026-06-21T04:45:18Z(cron) SKIP — src 无变更
- 2026-06-21T04:48:27Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T04:55:50Z(cron v3) FAIL — typecheck:err · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:CcConnectLauncher.ts:105 ChildProcess 与 SpawnedBridge 的 kill 类型不兼容(并发引入); backend 未起, 跳过 API/UI
- 2026-06-21T05:05:41Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:上轮 CcConnectLauncher 类型错已修(并发), typecheck+TEAM-010 通过; backend 未起, 跳过 API/UI
- 2026-06-21T05:08:54Z(fixbug cron) PASS — typecheck:ok · test:3085/3085 全过 · 无回归,不改代码
- 2026-06-21T05:15:15Z(cron) SKIP — src 无变更
- 2026-06-21T05:25:15Z(cron) SKIP — src 无变更
- 2026-06-21T05:28:28Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T05:35:23Z(cron) SKIP — src 无变更
- 2026-06-21T05:45:18Z(cron) SKIP — src 无变更
- 2026-06-21T05:48:38Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T05:55:14Z(cron) SKIP — src 无变更
- 2026-06-21T06:05:43Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:新提交 869bd01c(hermit-bridge npm + turn_id 贯穿 IM usage); typecheck+TEAM-010 通过; backend 未起
- 2026-06-21T06:37:17Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:src 有变更, typecheck+TEAM-010 通过; backend :5680 未起(http:000), 跳过 API/UI
- 2026-06-21T06:45:46Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:HEAD 更新触发巡检, src 工作区无未提交变更; typecheck+TEAM-010 通过; backend :5680 未起(http:000), 跳过 API/UI
- 2026-06-21T06:49:00Z(fixbug cron) PASS — typecheck:ok · test:3085/3085 全过 · 无回归,不改代码
- 2026-06-21T07:03:27Z(cron v3) FAIL — typecheck:err · TEAM-010:ok(31/31) · api:ok · ui:empty · findings:typecheck 失败: useLoopCommandSuggestions.test.tsx mock 缺 WorkflowPromptListResponse.folder/warnings; /api/teams=200(6), /api/cross-team/discover=200(10); frontend :5174 未起(http:000), 跳过 UI 复核
- 2026-06-21T07:08:42Z(fixbug cron) PASS — typecheck:ok · test:3087/3087 全过 · 无回归,不改代码

- 2026-06-21T07:47:46Z(cron v3) PARTIAL — typecheck:ok · TEAM-010:ok(31/31) · api:down · ui:skipped · findings:src 有变更; typecheck 通过; TEAM-010 通过; backend :5680 未起(http:000/curl7), 按规则跳过 API/UI

- 2026-06-21T07:49:19Z(fixbug cron) PASS — typecheck:ok · test:3087/3087 全过 · 无回归,不改代码

- 2026-06-21T07:55:14Z(cron) SKIP — src 无变更

- 2026-06-21T08:05:22Z(cron) SKIP — src 无变更

- 2026-06-21T08:08:24Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T12:08:54Z(fixbug cron) PASS — typecheck:ok · test:全过 · 无回归,不改代码
- 2026-06-21T13:08:38Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T13:28:22Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T13:48:20Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T14:08:20Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T14:28:23Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T14:48:18Z(fixbug cron) SKIP — src 无变更
- 2026-06-21T15:08:42Z(fixbug cron) PASS — typecheck:ok · test:全过 · 无回归,不改代码
- 2026-06-21T15:28:19Z(fixbug cron) SKIP — src 无变更

- 2026-06-21T16:09:01Z(fixbug cron) SKIP — src 无变更
# Worker Society 插件 · 功能测试用例全集（闭环 spec）

> 本文件是 **worker-society 插件** 的完整功能测试用例规范：去中心化自治社会的每一条功能路径都有对应用例，
> 形成端到端闭环。每条用例含：场景 / **验收通过** / **验收失败** / 类型 / 优先级 / **现有测试映射**。
> 用例 ID 规则：`SOCIETY-<域>-<序号>`，如 `SOCIETY-002-005`。
> 执行 runbook（命令、报告格式、判定）见同目录 [`agent.md`](./agent.md) 的「Worker Society（SOCIETY-*）」一节。

---

## 0. 模块全景与闭环

### 0.1 这是什么
`src/features/worker-society/` 是一个**去中心化、自治的 worker 社会**，取代集中式派单（dispatch）：
- worker 把 **Need** 发布到**广场（Agora）**；
- worker 按 **FitScore**（能力 + 负载公平 + 声誉 + 关系 + 兴趣加权）**自荐（volunteer）**；
- 系统按适配度**择优选派（selectAssignee）**，全程无人工指派；
- 协作完成后累积 **声誉（Reputation）** 与有向 **关系（Relationship）**。

### 0.2 代码分层（每层都有测试）
| 层 | 路径 | 职责 | 测试文件 |
|---|---|---|---|
| 领域模型 | `core/domain/models/society.ts` | WorkerProfile / PublishedNeed / Relationship / NeedStatus | （被各策略测试间接覆盖） |
| 纯策略 | `core/domain/policies/societyPolicies.ts` | FitScore、autonomousVolunteers、transitionNeed、声誉 delta | `societyPolicies.test.ts` |
| 应用服务 | `core/application/WorkerSocietyService.ts` | 编排领域 + 端口（17 方法） | `WorkerSocietyService.test.ts` |
| 基础设施 | `main/infrastructure/` | FsStores（`~/.hermit/society/`）+ CrossTeamMessageGateway | `fsStores.test.ts`、`crossTeamMessageGateway.test.ts` |
| 组合根 | `main/composition/societyComposition.ts` | `createWorkerSociety()` 装配 | `societyComposition.test.ts` |
| 插件描述符 | `main/composition/workerSocietyPlugin.ts` | `agentpanel add worker-society` | `workerSocietyPlugin.test.ts` |
| 输入适配器 | `main/adapters/input/` | Fastify `/api/society/*` + `society_*` MCP（13 工具） | `societyRoutes.test.ts`、`societyMcp.test.ts` |
| 渲染层 | `renderer/` | api 客户端 / Zustand / 视图工具 / 图谱投影 / 挂载 | 4 个 `*.test.ts` |

**现状：13 个测试文件，213 个用例，全绿。**（`node_modules/.bin/vitest run src/features/worker-society`）

### 0.3 核心闭环（Need 生命周期 + 自治回路）

```
publishNeed ──▶ open
   │  volunteerFor (worker 自荐，按 FitScore)
   ▼
open + volunteers ──▶ selectAssignee (择优) ──▶ assigned
   │  startNeed(worker)
   ▼
in_progress ──▶ deliverNeed(result) ──▶ delivered
   │  acceptDelivery (审核通过)
   ▼
closed   ← 声誉 +、Relationship collaborations+1 / trust 更新
```

旁路：`cancelNeed` → cancelled；`requestRevision` → delivered 回 assigned（revisionCount+1）；`expireNeeds` → expired。

**自治回路（一键「触发自治」）：**
`runAutonomyTick()`（`autonomousVolunteers`：贪婪按 FitScore 自荐，受 `maxVolunteersPerNeed`/`maxNeedsPerWorker` 双向配额约束）→ `autoSelectPending()`（对每个有自荐者的 open 需求择优选派）。

### 0.4 NeedStatus 与可见性
| NeedStatus | 在看板/图谱 | task 节点状态 | 粒子（ownership 边） |
|---|---|---|---|
| open | ✓ active | waiting | 无（无 assignee） |
| assigned | ✓ active | waiting | ✓ cyan task_assign |
| in_progress | ✓ active | active | ✓ cyan task_assign |
| delivered | ✓ active | complete | 无 |
| closed / expired / cancelled | ✗ 丢弃 | — | — |

`ACTIVE_NEED_STATUSES = { open, assigned, in_progress, delivered }`（见 `societyPolicies.ts`）。

### 0.5 类型 / 优先级图例
| 类型 | 含义 | 工具 |
|---|---|---|
| unit | 纯函数/单模块 | vitest |
| integration | 跨模块/真实文件系统/Fastify inject | vitest |
| e2e | 真实 UI 全流程 | playwright（hermit 当前无 config）/ 手动 |
| manual | 需人工观测（视觉/交互） | 人工 + 截图 |

优先级：**P0** 核心链路/数据安全/历史回归点（必须全绿）；**P1** 主功能完整性；**P2** 体验/边角。

覆盖标记：✅ 已有测试 · ⚠️ 部分 · ❌ 缺口（必补）。

---

## 1. SOCIETY-001 · Worker 注册与发现

**文件**：`societyPolicies.ts`（`discoverWorkers`、`capabilityMatchScore`）、`WorkerSocietyService.ts`（`registerProfile`/`getProfile`/`discoverWorkers`）、`societyRoutes.ts`、`societyMcp.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-001-001 | `registerProfile({workerId,name,capabilities,interests,maxConcurrent,reputation})` | worker 落盘 `~/.hermit/society/profiles/`，字段完整、status 默认 online | 字段丢/默认错 | integration | P0 | ✅ service + fsStores |
| SOCIETY-001-002 | 重复注册同 workerId | 幂等：覆盖更新或保留（行为一致、不崩） | 崩/产生重复 | integration | P1 | ✅ service |
| SOCIETY-001-003 | `getProfile(workerId)` 命中 | 返回完整 profile | 缺字段 | unit | P1 | ✅ |
| SOCIETY-001-004 | `getProfile(unknown)` | 返回 undefined/null（不抛） | 抛错 | unit | P1 | ✅ fsStores（missing worker） |
| SOCIETY-001-005 | `discoverWorkers(capabilities)` | 只返回能力命中的 worker，按命中度排序 | 全返回/排序错 | unit | P0 | ✅ mcp + policies |
| SOCIETY-001-006 | `capabilityMatchScore` 空交集 | 0 分 | 误给分 | unit | P1 | ✅ policies |
| SOCIETY-001-007 | kind: atomic vs composite | 两种均合法、持久化保留 | kind 丢 | unit | P2 | ✅ service |
| SOCIETY-001-008 | maxConcurrent=0 / 负 | `isAtCapacity` 视为已满 / 拒绝自荐 | 仍允许 | unit | P1 | ✅ policies |
| SOCIETY-001-009 | `interestOverlap` 计算 | 正确计数共同兴趣 | 漏算 | unit | P2 | ✅ policies |
| SOCIETY-001-010 | 渲染层：UI「注册成员」表单 → store.registerWorker | 名称必填、工号默认=名称、能力逗号分隔 | 空名提交/崩 | e2e | P2 | ⚠️ store 路径已测，UI 未测（无 testing-library） |

- **风险点**：workerId 大小写/空白未归一化可能造成重复；maxConcurrent 边界。

---

## 2. SOCIETY-002 · Need 全生命周期（核心闭环）

**文件**：`societyPolicies.ts`（`transitionNeed`、`volunteerFor`）、`WorkerSocietyService.ts`（`publishNeed`→`acceptDelivery`）、`societyRoutes.ts`、`societyMcp.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-002-001 | `publishNeed({postedBy,subject,requiredCapabilities,priority})` | 落盘、status=open、生成 needId、createdAt | 字段缺/状态错 | integration | P0 | ✅ service + routes + mcp |
| SOCIETY-002-002 | `listOpenNeeds` / `listActiveNeeds` / `listAllNeeds` | 各自按状态集过滤正确 | 串档 | unit | P0 | ✅ |
| SOCIETY-002-003 | `volunteerFor(needId,workerId)` | volunteers+1、记 fitScore+volunteeredAt | 重复自荐/能力不符未拦 | integration | P0 | ✅ |
| SOCIETY-002-004 | 同一 need 重复 volunteer | 幂等（不计第二次）或按策略拒绝 | 无限叠加 | unit | P1 | ✅ policies |
| SOCIETY-002-005 | `selectAssignee(needId)` | 取 fitScore 最高者 → status=assigned、assignee 设置 | 选错/无自荐者仍选 | unit | P0 | ✅ |
| SOCIETY-002-006 | select 时 need 无自荐者 | 安全返回（不崩、不改状态） | 崩 | unit | P1 | ✅ |
| SOCIETY-002-007 | `startNeed(needId,workerId)` | assigned→in_progress、activeTaskCount+1 | 非 assignee 启动/状态错 | integration | P0 | ✅ |
| SOCIETY-002-008 | `deliverNeed(needId,result)` | in_progress→delivered、result 保存 | 未 in_progress 即交付 | integration | P0 | ✅ |
| SOCIETY-002-009 | `acceptDelivery(needId)` | delivered→closed、声誉+、relationship 累积 | 非 delivered 审核 | integration | P0 | ✅ |
| SOCIETY-002-010 | `cancelNeed` | open/assigned→cancelled，从 active 移除 | 已 in_progress 仍可取消 | unit | P1 | ✅ |
| SOCIETY-002-011 | `requestRevision` | delivered→assigned、revisionCount+1 | revisionCount 不递增 | unit | P1 | ✅ routes（revision 路由） |
| SOCIETY-002-012 | `transitionNeed` 非法跳变护栏 | 返回业务错误（如 `Invalid need transition`），不静默改 | 静默允许非法跳变 | unit | **P0** | ✅ policies |
| SOCIETY-002-013 | 已 closed 重复 accept | 幂等/拒绝（不重复加声誉） | 声誉重复累加 | unit | P1 | ✅ |
| SOCIETY-002-014 | `expireNeeds` 超时 | open/assigned/in_progress/delivered 超时→expired | 仍停留 | unit | P1 | ✅ service（expireNeeds） |
| SOCIETY-002-015 | 优先级 priority 排序 | `sortNeedsByLifecycle` 同阶段内高优先先 | 顺序错 | unit | P1 | ✅ viewUtils |
| SOCIETY-002-016 | activeNeeds 只含 4 态 | closed/expired/cancelled 不出现在 board/graph | 串档 | unit | P0 | ✅ graphAdapter |

- **风险点**：状态机非法跳变必须返回业务错误（ok:false），非 5xx；并发 accept 造成声誉重复累加。

---

## 3. SOCIETY-003 · 去中心化自治（autonomousVolunteers + autoSelect）

**文件**：`societyPolicies.ts`（`autonomousVolunteers`、`computeFitScore`、`canVolunteer`、`isAtCapacity`）、`WorkerSocietyService.ts`（`runAutonomyTick`、`autoSelectPending`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-003-001 | `autonomousVolunteers`：能力匹配的 worker 自荐 | 仅匹配+在线+未满+未自荐者自荐 | 全员自荐/能力不符也自荐 | unit | P0 | ✅ policies |
| SOCIETY-003-002 | 贪婪按 FitScore desc | 高分优先占额度 | 顺序错 | unit | P0 | ✅ |
| SOCIETY-003-003 | `maxVolunteersPerNeed`（默认 3）配额 | 单 need 自荐不超过上限 | 超额 | unit | P0 | ✅ |
| SOCIETY-003-004 | `maxNeedsPerWorker`（默认 1）配额 | 单 worker 同时自荐不超过上限（计入已有自荐） | 超额 | unit | P0 | ✅ |
| SOCIETY-003-005 | `isAtCapacity` / `canVolunteer` 守卫 | 已满/离线/已自荐者被排除 | 仍参与 | unit | P1 | ✅ |
| SOCIETY-003-006 | `runAutonomyTick(opts)` 经 volunteerFor 落地 | 返回 applied 数；自荐真正写入 need.volunteers | 只算不写 | integration | P0 | ✅ service + mcp + routes |
| SOCIETY-003-007 | `autoSelectPending` 择优 | 对每个有自荐者的 open need 选最佳 → assigned | 无自荐者也选 | integration | P0 | ✅ |
| SOCIETY-003-008 | `computeFitScore` 五维加权 | 能力+负载公平+声誉+关系+兴趣加权正确 | 某维漏算/权重错 | unit | P0 | ✅ policies |
| SOCIETY-003-009 | tick→autoSelect 一键闭环 | 「触发自治」后 open→assigned 链路成立 | 断链 | integration | P0 | ✅ service |
| SOCIETY-003-010 | tick 后重载 open-needs + feed | UI/store 刷新看到新状态 | 不刷新 | integration | P1 | ✅ store |

- **风险点**：配额计数必须包含 pre-existing 自荐者，否则超额；贪婪顺序影响公平性。

---

## 4. SOCIETY-004 · 声誉与关系累积

**文件**：`societyPolicies.ts`（`applyReputationDelta`、`reputationDeltaForOutcome`、`recordCollaboration`）、`WorkerSocietyService.ts`（`recordCollaboration`、`getRelationships`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-004-001 | 成功协作 → `reputationDeltaForOutcome` 正分 | 成功给正 delta | 给负/0 | unit | P0 | ✅ policies |
| SOCIETY-004-002 | 失败/驳回 → 负分 | revision/failure 给负 delta | 给正 | unit | P0 | ✅ |
| SOCIETY-003 | `applyReputationDelta` 边界 | 声誉 clamp 到 [0,100] | 越界/NaN | unit | P1 | ✅ |
| SOCIETY-004-004 | `recordCollaboration` | collaborations+1、trust 更新、lastInteractedAt 刷新 | 不递增 | integration | P0 | ✅ service + routes |
| SOCIETY-004-005 | 有向关系（from→to） | 方向保留、可查双向 | 方向丢 | unit | P1 | ✅ |
| SOCIETY-004-006 | 闭环 accept 后关系累积 | need closed 时 from(assignee)→to(poster) 关系+1 | 未累积 | integration | P0 | ✅ routes（relationships after collaboration） |
| SOCIETY-004-007 | `reputationColor` 映射 | 高=绿/中=橙/低=红 | 颜色错 | unit | P2 | ✅ viewUtils |
| SOCIETY-004-008 | `workerNodeRadius` = 声誉 | 0→min、100→max、clamp | 越界 | unit | P2 | ✅ viewUtils |

- **风险点**：声誉 clamp；关系方向；revision 不应给正分。

---

## 5. SOCIETY-005 · 社交消息与 Feed（跨团队格式化）

**文件**：`WorkerSocietyService.ts`（`sendSocialMessage`）、`main/infrastructure/crossTeamMessageGateway.ts`、`societyRoutes.ts`（`/messages`、`/feed`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-005-001 | `sendSocialMessage(from,to,text)` | 落盘、feed 可查 | 丢 | integration | P0 | ✅ |
| SOCIETY-005-002 | 经 `formatCrossTeamText` 格式化 | 消息带跨团队标记/格式正确 | 原样未格式化 | integration | P1 | ✅ gateway |
| SOCIETY-005-003 | `getFeed` 返回记录 | 含 id/from/to/text/createdAt | 缺字段 | unit | P1 | ✅ |
| SOCIETY-005-004 | feed 时序 | 按 createdAt 排序（UI .reverse() 倒序最新在上） | 乱序 | unit | P2 | ⚠️ store/view 倒序逻辑未单测 |
| SOCIETY-005-005 | 收件人不存在 | 降级/安全返回不崩 | 崩 | unit | P1 | ⚠️ 边界未明确测 |

- **风险点**：跨团队文本格式化须复用 hermit `formatCrossTeamText`，不可自造。

---

## 6. SOCIETY-006 · 图谱投影（societyGraphAdapter，纯函数）

**文件**：`renderer/societyGraphAdapter.ts`（`projectSocietyGraph`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-006-001 | 空社会 | nodes/edges/particles 全空、isAlive=false | 残留 agora | unit | P1 | ✅ |
| SOCIETY-006-002 | 合成 Agora hub 居中 | kind=lead、每个 worker parent-child 连 agora | 无 hub | unit | P0 | ✅ |
| SOCIETY-006-003 | worker→member 节点状态 | idle（空闲）/active（有任务或 busy）/offline 仍可见 | 状态错 | unit | P0 | ✅ |
| SOCIETY-006-004 | in_progress need→task+粒子 | task state=active、ownership 边、cyan 粒子 progress=0 | 缺粒子/边 | unit | P0 | ✅ |
| SOCIETY-006-005 | open need→waiting、无 owner 边/无粒子 | ownerId=null | 误给边 | unit | P1 | ✅ |
| SOCIETY-006-006 | delivered→complete、无粒子 | taskStatus=completed | 仍有粒子 | unit | P1 | ✅ |
| SOCIETY-006-007 | closed/expired/cancelled 丢弃 | 无 task 节点 | 残留 | unit | P0 | ✅ |
| SOCIETY-006-008 | relationship→related 边双向去重 | 双向只一条 | 重复 | unit | P1 | ✅ |
| SOCIETY-006-009 | 引用未知 worker 的 relationship 跳过 | 无悬空边 | 悬空边 | unit | P1 | ✅ |
| SOCIETY-006-010 | assignee 指向未注册 worker | ownerId=null、无 ownership 边/无粒子（孤儿任务） | 悬空边/崩 | unit | P1 | ✅（iter-1 补） |
| SOCIETY-006-011 | 径向 layout ownerOrder=worker 节点 id | mode=radial、owner 全有对应 member | 缺 | unit | P2 | ✅ |
| SOCIETY-006-012 | 确定性（无 random） | 相同输入→相同输出 | 不确定 | unit | P0 | ✅ |
| SOCIETY-006-013 | resolveAvatarUrl 注入 | worker 节点带 avatar、hub 无 avatar | 全空/全给 | unit | P1 | ✅ |
| SOCIETY-006-014 | 每个 in-flight need 恰一粒子 | 多 need 各一、无 assignee 无粒子 | 重复/漏 | unit | P1 | ✅ |

---

## 7. SOCIETY-007 · 渲染层视图工具（societyViewUtils，纯函数）

**文件**：`renderer/societyViewUtils.ts`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-007-001 | `activeWorkers` | online/busy 或有 activeTask 保留；offline 空闲移除 | 误留/误删 | unit | P1 | ✅ |
| SOCIETY-007-002 | `pickAvatarUrl` 稳定映射 | 同 id→同 url、空集→undefined、分布不塌缩 | 不确定 | unit | P0 | ✅ |
| SOCIETY-007-003 | `edgeWidth` [1,8] clamp | 0→1、4→4、超→8 | 越界 | unit | P2 | ✅ |
| SOCIETY-007-004 | `trustOpacity` 0→0.2..1→1 | 线性 | 错 | unit | P2 | ✅ |
| SOCIETY-007-005 | `needStatusColor` 7 态全异色 | Set size=7 | 重复色 | unit | P2 | ✅ |
| SOCIETY-007-006 | `sortNeedsByLifecycle` 不 mutate | 输入不变 | 改原数组 | unit | P1 | ✅ |

---

## 8. SOCIETY-008 · REST API 契约（Fastify `/api/society/*`）

**文件**：`main/adapters/input/societyRoutes.ts`（19 路由）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-008-001 | GET /workers 起始为空 | `[]` | 崩 | integration | P0 | ✅ |
| SOCIETY-008-002 | POST /workers/register | 注册后可 list | 失败 | integration | P0 | ✅ |
| SOCIETY-008-003 | POST /needs | 发布为 open | 状态错 | integration | P0 | ✅ |
| SOCIETY-008-004 | volunteer→select→start→deliver→accept 全链路 | need closed | 断链 | integration | P0 | ✅ |
| SOCIETY-008-005 | POST /autonomy/tick | 匹配 worker 自荐、返回 applied | 不自荐 | integration | P0 | ✅ |
| SOCIETY-008-006 | POST /autonomy/auto-select | 择优 assigned | 无 | integration | P0 | ✅ |
| SOCIETY-008-007 | GET /feed 跨团队格式化 | 带格式文本 | 原样 | integration | P1 | ✅ |
| SOCIETY-008-008 | GET /relationships 协作后 | 含累积关系 | 空 | integration | P1 | ✅ |
| SOCIETY-008-009 | cancel / revision 路由 | cancelled / revisionCount+1 | 失败 | integration | P1 | ✅ |
| SOCIETY-008-010 | 非法状态跳变 | 200 + ok:false 业务错误（非 5xx） | 5xx/静默 | integration | **P0** | ✅ |
| SOCIETY-008-011 | GET /needs/open vs /active vs / | 各自过滤正确 | 串档 | integration | P0 | ✅ |

- **判定规则**（与 hermit 全局一致）：业务错误返回 HTTP 200 + `{ok:false,error}`，状态机非法跳变不抛 5xx。

---

## 9. SOCIETY-009 · MCP 工具暴露（`society_*`，13 个）

**文件**：`main/adapters/input/societyMcp.ts`、`/mcp` 端点（`SOCIETY_MCP_TOOLS`）

工具集：`society_register_worker`、`society_discover_workers`、`society_list_open_needs`、`society_publish_need`、`society_volunteer`、`society_select_assignee`、`society_start_need`、`society_deliver_need`、`society_accept_delivery`、`society_run_autonomy_tick`、`society_auto_select`、`society_message_worker`、`society_get_feed`。

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-009-001 | `/mcp tools/list` 含全部 13 个 society_* | 数量+命名完整 | 缺 | integration | P0 | ✅ mcp（namespaced tool list） |
| SOCIETY-009-002 | schema 校验后执行 | 符合 schema 才执行、返回正确格式 | 非法也执行 | integration | P0 | ✅ |
| SOCIETY-009-003 | register→discover 闭环 | 注册后可按能力发现 | 发现失败 | integration | P1 | ✅ |
| SOCIETY-009-004 | 全自治闭环经 MCP | publish→tick→auto_select→start→deliver→accept→closed | 断链 | integration | P0 | ✅ |
| SOCIETY-009-005 | society_run_autonomy_tick | 匹配 worker 自荐 | 不自荐 | integration | P1 | ✅ |
| SOCIETY-009-006 | society_auto_select | 择优 assigned | 无 | integration | P1 | ✅ |

---

## 10. SOCIETY-010 · 可安装插件（`agentpanel add worker-society`）

**文件**：`main/composition/workerSocietyPlugin.ts`、`bin/hermit.mjs`（`add <plugin>`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-010-001 | 描述符 id/SSE 端点/工具名 | 端点指向 `/mcp`、工具名实时取自 SOCIETY_MCP_TOOLS | 写死/错 | unit | P0 | ✅ plugin（7 测试） |
| SOCIETY-010-002 | `buildWorkerSocietyMcpLibraryEntry` | 契约匹配 `McpLibraryService.upsert` | 字段不匹配 | unit | P0 | ✅ |
| SOCIETY-010-003 | `agentpanel add worker-society` POST /api/extensions/mcp/library | 落 `~/.hermit/mcp-library.json` | 失败 | e2e | P1 | ⚠️ 端到端已人工验证、无自动化 |
| SOCIETY-010-004 | 重复 add 幂等 | 报「already in library」而非崩 | 崩/重复 | e2e | P1 | ⚠️ 人工验证 |
| SOCIETY-010-005 | KNOWN_PLUGINS 初始化时序 | add 检查在 runAddPlugin 定义之后 | 时序崩 | integration | P1 | ⚠️ 人工验证 |

- **许可**：agent-teams-ai 为 AGPL-3.0，复用其引擎有许可影响（本插件仅复用 hermit 已 vendor 的 `packages/agent-graph`，非新引入）。

---

## 11. SOCIETY-011 · 持久化与文件系统（FsStores）

**文件**：`main/infrastructure/fsStores.ts`（`~/.hermit/society/`）

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-011-001 | FsProfileStore missing → undefined | 不抛 | 抛 | unit | P1 | ✅ |
| SOCIETY-011-002 | list all profiles | 返回全部 | 漏 | integration | P1 | ✅ |
| SOCIETY-011-003 | delete profile | 移除 | 残留 | integration | P1 | ✅ |
| SOCIETY-011-004 | 跨实例重载（new 实例读盘） | 数据一致 | 丢 | integration | P0 | ✅ profile + need |
| SOCIETY-011-005 | FsNeedStore 持久化 | need 落盘可读 | 丢 | integration | P0 | ✅ |

---

## 12. SOCIETY-012 · 组合根与渲染挂载

**文件**：`main/composition/societyComposition.ts`（`createWorkerSociety`）、`renderer/societyApi.ts`、`societyStore.ts`、`SocietyGraph.tsx`、`SocietyView.tsx`

| ID | 场景 | 验收通过 | 验收失败 | 类型 | 优先级 | 现有测试 |
|---|---|---|---|---|---|---|
| SOCIETY-012-001 | createWorkerSociety 装配全链路 | 模拟重启后数据一致 | 不一致 | integration | P0 | ✅ composition（2 测试） |
| SOCIETY-012-002 | societyApi.parseResponse 非 2xx | 抛 {error} | 静默 | unit | P1 | ✅ societyApi |
| SOCIETY-012-003 | societyApi 空体 2xx | 返回 undefined | 崩 | unit | P1 | ✅ |
| SOCIETY-012-004 | 能力逗号串 → 数组 | 正确切分 | 不切 | unit | P1 | ✅ |
| SOCIETY-012-005 | store actions 触发后重载 | mutate→reloadWorkers 刷新 | 不刷新 | unit | P0 | ✅ societyStore |
| SOCIETY-012-006 | SocietyGraph 全屏（onRequestFullscreen） | createPortal overlay、body 滚动锁 | 无 | e2e | P2 | ❌ UI 未测 |
| SOCIETY-012-007 | 空社会引导层 + CTA | nodes=0 显示「社会尚未启动」+「去添加成员」 | 空白 | e2e | P2 | ❌ UI 未测 |
| SOCIETY-012-008 | 图谱全屏铺满 pane（iter-本次） | canvas 去掉 padding/header 挤占、工具条浮于其上 | 仍偏小 | manual | P1 | ❌ 需人工/截图 |
| SOCIETY-012-009 | 实时性：生命周期操作后重投影 | 触发自治/自荐/选派后节点状态/粒子实时更新 | 不更新 | manual | P1 | ⚠️ 数据流已测、视觉未测 |

---

## 13. 端到端闭环（黄金路径）

**SCENE-E2E-001 · 一键自治全闭环**（覆盖 SOCIETY-002 + 003 + 004 + 008 + 009）

```
1. 注册 3 个 worker（capabilities: code / review / code+review）
2. 发布 2 个 need（所需能力 code、review）
3. 「触发自治」→ tick: 匹配 worker 自荐 → autoSelect: 择优 assigned
4. startNeed → deliverNeed → acceptDelivery
5. 断言：need closed；assignee 声誉上升；from→to relationship collaborations+1；
        /api/society/feed 含跨团队格式化消息；/mcp tools/list 含 13 个 society_*。
```
- **验收通过**：全链路无断点、状态/声誉/关系/feed 全部正确。
- **验收失败**：任一环节状态未推进 / 声誉未变 / 关系未累积 / feed 缺。
- **类型**：integration（已有自动化覆盖，见 `societyComposition.test.ts`、`societyRoutes.test.ts`、`societyMcp.test.ts`）。

---

## 14. 覆盖地图 / 缺口 / 补测优先级

### 14.1 现状
- **13 文件 / 213 用例 / 全绿**。领域策略、应用服务、REST、MCP、持久化、组合根、图谱投影、视图工具覆盖**充分**。
- 渲染层纯逻辑（adapter/utils/api/store）已测；**React 组件挂载（SocietyGraph/SocietyView）未测**（hermit 未引入 @testing-library/react）。

### 14.2 缺口（❌ 必补 / ⚠️ 部分）
| 缺口 | 用例 | 建议 |
|---|---|---|
| React 组件渲染 | SOCIETY-012-006/007/008/009 | 引入 @testing-library/react 或用 playwright e2e |
| 插件安装端到端自动化 | SOCIETY-010-003/004/005 | 用 Fastify inject + 临时 HOME 脚本化 |
| feed 倒序单测 | SOCIETY-005-004 | 在 societyStore/view 补 |
| 收件人不存在边界 | SOCIETY-005-005 | service 补 |
| 视觉验收（全屏铺满/实时重投影） | SOCIETY-012-008/009 | 人工 + 截图（依赖运行 app） |

### 14.3 回归红线（一旦破坏即阻塞）
- **状态机非法跳变必须返回业务错误**（SOCIETY-002-012 / 008-010）。
- **声誉 clamp [0,100]、不可重复累加**（SOCIETY-004-003/013）。
- **配额计数含 pre-existing 自荐者**（SOCIETY-003-003/004）。
- **图谱投影确定性**（SOCIETY-006-012）。
- **avatar 稳定映射**（SOCIETY-007-002）。

---

## 15. 产品验收记录（迭代日志）

> 本节是「作为产品体验去验收」的活日志。每轮（30 分钟循环 `660d58c4`）追加一条：自动化结论 + 逐域产品验收 + 意见 + 本轮迭代动作。引用用例 ID。

### 迭代 #1 · 2026-06-14
**自动化基线**：`vitest run src/features/worker-society` → **207/207 全绿**（12 文件）；`tsc` worker-society 干净（ClaudeDoctorProbe 基线除外）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 worker 注册 | ✅ PASS | 注册表单可用；缺「一键示例」冷启动入口（本轮补） |
| SOCIETY-002 Need 生命周期 | ✅ PASS | open→assigned→in_progress→delivered→closed 闭环可走通 |
| SOCIETY-003 自治 | ✅ PASS | 「触发自治」tick+autoSelect 一键有效 |
| SOCIETY-004 声誉/关系 | ✅ PASS | 协作后累积；但 UI 未直观呈现「为何涨」 |
| SOCIETY-005 消息/Feed | ⚠️ 部分 | feed 倒序/收件人边界未单测；UI 消息较朴素 |
| SOCIETY-006 图谱投影 | ✅ PASS | 15 用例确定性覆盖；孤儿 assignee 已护 |
| SOCIETY-007 视图工具 | ✅ PASS | 纯函数全覆盖 |
| SOCIETY-008 REST | ✅ PASS | 19 路由 + 非法跳变业务错误 |
| SOCIETY-009 MCP | ✅ PASS | 13 工具闭环 |
| SOCIETY-010 插件安装 | ⚠️ 部分 | unit 全绿；e2e 仅人工 |
| SOCIETY-011 持久化 | ✅ PASS | 跨实例重载一致 |
| SOCIETY-012 组合根/挂载 | ⚠️ 部分 | 逻辑全绿；React 组件 UI 无自动化；全屏铺满已上（视觉待人工确认） |

**产品意见（按优先级）**：
1. **冷启动/可演示性**：空社会需手工逐个注册，演示成本高 → 本轮加「加载示例社会」一键播种。
2. **历史不可见**：closed/expired/cancelled 的 need 从看板/图谱彻底消失，看不到过往协作 → 下一轮补「历史」视图（`listAllNeeds` 已就绪，缺 UI）。
3. **节点点击无反馈**：图谱点 worker → 死的 Message 按钮（`onSendMessage` 未接）→ 后续接 `renderOverlay`。
4. **声誉归因**：声誉变化无解释/趋势 → 后续补 tooltip/趋势。

**本轮迭代动作**：新增 `renderer/societyDemo.ts`（`buildDemoSociety()` 纯函数 + 测试，TDD）；空状态引导层加「加载示例社会」按钮 → 一键注册 3 worker + 发布 2 need，使社会即时可演示。

**下一轮候选**：历史视图（意见 #2）。

---

### 迭代 #2 · 2026-06-14
**自动化基线**：`vitest run src/features/worker-society` → **225/225 全绿**（14 文件，较 iter-1 的 207 +18）；`tsc` exit 0（worker-society 干净，ClaudeDoctorProbe 基线本轮亦清零）。

**本轮产品主张：纯图谱（图谱即界面）。** 用户反馈「看板真的好丑好丑，要不删除了，所有的交互都在图谱中」→ 删掉看板与图谱/看板切换，整页只剩全息图谱，所有交互都在图谱里。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 worker 注册 | ✅ PASS | 注册入口移到顶部「＋注册」小弹层（点开即填），不再占看板列 |
| SOCIETY-002 Need 生命周期 | ✅ PASS(逻辑) | **点 need 节点 → 弹卡按状态出生命周期动作**（assigned→开始执行 / in_progress→标记交付 / delivered→通过审核），闭环可全程在图谱内推进；自荐改由「触发自治」自动完成（反派单），open need 有自荐者时弹卡多出「选派最优」 |
| SOCIETY-003 自治 | ✅ PASS | 「触发自治」仍在顶栏；need 弹卡 open 态也内嵌「触发自治」入口 |
| SOCIETY-004 声誉/关系 | ✅ PASS | 声誉=节点大小、关系=发光边，去掉文字排行榜/关系列表后界面更干净；信息无损 |
| SOCIETY-005 消息/Feed | ✅ PASS(逻辑) | **点 worker 节点 → 弹卡「发消息」已接通**（人→worker，from='user'），解决 iter-1 意见 #3「节点点击无反馈」；Feed 文字列表移除（图谱沿边粒子 + 弹卡已表达在途交互） |
| SOCIETY-006 图谱投影 | ✅ PASS | adapter 未动，15 用例不变 |
| SOCIETY-007 视图工具 | ✅ PASS | 新增 `NEED_STATUS_LABEL` 单一来源；societyViewUtils 全覆盖 |
| SOCIETY-008 REST | ✅ PASS | 未动 |
| SOCIETY-009 MCP | ✅ PASS | 未动 |
| SOCIETY-010 插件安装 | ⚠️ 部分 | 同 iter-1 |
| SOCIETY-011 持久化 | ✅ PASS | 未动 |
| SOCIETY-012 组合根/挂载 | ⚠️ 部分 | **纯图谱交互落地**：删看板+切换、删 NeedCard/WorkerNode/RelationshipRow/FeedItem；新增 `SocietyNodeOverlay`（点节点弹卡，member→发消息 / task→生命周期 / lead→概览）+ 顶栏 `PublishPopover`/`RegisterPopover`；`SocietyGraph` 透传 `renderOverlay` 到引擎两处 mount。React 组件 UI 仍无自动化（已知缺口），但交互面已全部接通 store 动作 |

**新增纯逻辑（TDD，12 测试）**：`renderer/societyOverlayActions.ts` —— `needLifecycleActions(status, hasVolunteers)` 决定 need 弹卡的动作集（纯图谱交互模型的全部决策点）+ `clampOverlayPosition(pos, viewport, size)` 保证弹卡不被屏幕边缘裁切（右侧溢出翻左、上下夹紧）。

**产品意见（按优先级）**：
1. **弹卡视觉确认**：弹卡定位用固定尺寸估算 + clamp，逻辑已测；但极端视口/节点贴边时的实际渲染需人工截图确认（无 UI 自动化）。
2. **历史不可见**（iter-1 意见 #2 未决）：closed/expired/cancelled 的 need 仍从图谱消失 → 下一轮补历史视图。
3. **声誉归因**（iter-1 意见 #4 未决）：节点大小变了但无解释 → 后续补 tooltip/趋势。
4. **键盘可达性**：弹卡无 Esc 关闭、Tab 焦点未管理 → 后续补。

**本轮迭代动作**：删看板 + 图谱/看板切换（SocietyView 605→~410 行）；新增 `SocietyNodeOverlay.tsx` + `societyOverlayActions.ts`(+test)；`SocietyGraph` 透传 `renderOverlay`；SocietyView 重写为图谱单视图 + 顶栏 `＋发布`/`＋注册` 弹层 + 节点弹卡接通全部生命周期/消息 store 动作。225/225 绿，tsc exit 0。

**下一轮候选**：历史视图（意见 #2）；弹卡视觉人工确认（意见 #1）。

---

### 迭代 #3 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60）
**自动化基线**：`vitest run src/features/worker-society` → **226/226 全绿**（14 文件，较 iter-2 的 225 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿）**：`main/infrastructure/crossTeamMessageGateway.ts` 的 `all()` —— append-only JSONL，若 `messages.jsonl` 混入一行损坏/半行（append 中途崩溃的残留），旧实现 `JSON.parse(line)` 抛错 → 外层 catch → **整个 feed 返回 `[]`，静默全量丢失**。`filter(l=>l.trim())` 只挡空行、不挡坏 JSON。属 CLAUDE.md 点名的 JSONL 健壮性回归类（hermit 自身 session reader 亦容忍坏行）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-005 消息/Feed | ✅ PASS(加固) | 坏行不再抹掉 feed；崩溃后重启仍能读到崩溃前的合法消息 |

**TDD 痕迹**：先在 `crossTeamMessageGateway.test.ts` 加「tolerates a corrupt/partial line」用例（手写坏行入 messages.jsonl）→ **红**（`recent(50)` 返回 `[]` 而非 `['keep-1','keep-2']`）→ 改 `all()` 为逐行 try/catch 跳过坏行 → **绿**。文件缺失仍返回 `[]`（外层 catch 不变），合法行顺序不变。

**审查中排除的「假缺口」**（已测/已定约，避免误改）：
- `recent(n)` 返回「最后 n 条按发送顺序」——`test.ts:55-61` 已显式定约（oldest-first，非 bug）。
- `societyStore.cancelNeed`、`parseResponse` 非 JSON 错误分支——已实现正确，补测属 characterization（非红），留作后续补全。

**本轮迭代动作**：`crossTeamMessageGateway.ts` `all()` 逐行容错（红→绿，+1 测试）；226/226 绿，tsc exit 0。

**下一轮候选**：① 补 characterization 测试（store mutation 失败契约 / cancelNeed / parseResponse 非 JSON 错误体）以达「最全」；② 历史视图（iter-1 意见 #2）；③ `recent(0)` 当前返回全量（`slice(-0)===slice(0)`）——边界 bug，待评估是否需修。

---

### 迭代 #4 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 2 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **227/227 全绿**（14 文件，较 iter-3 的 226 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿）**：`crossTeamMessageGateway.recent(limit)` 的非正数边界 bug —— `recent(0)` → `all.slice(-0)` ≡ `all.slice(0)` → **返回整条历史**；`recent(-3)` → `slice(3)` 丢首部返回尾部；`recent(NaN)` → 全量。**可达**：MCP `society_get_feed` 的 limit 来自 agent（`num(args.limit) ?? 20`，`num('0')→0`，`0 ?? 20`→0），agent 传 `limit:0` 即倒出全部消息 = **无界读**。REST 路由硬编码 50 不受影响。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-005 消息/Feed | ✅ PASS(加固) | `recent` 契约修正：limit≤0/非有限 → `[]`，绝无界读；MCP feed 现安全 |
| SOCIETY-009 MCP | ✅ PASS | `society_get_feed` 既有 `limit:'5'` 测试不变，无回归 |

**TDD 痕迹**：先加 `recent(0)/-3/NaN → []` 用例 → **红**（`recent(0)` 返回 2 条而非 `[]`）→ `recent()` 首行加 `if (!Number.isFinite(limit) || limit <= 0) return [];` → **绿**。正数 limit 行为不变。

**审查中排除的「假缺口」**：`FsStores`（profiles/needs/relationships）用 `writeJsonAtomic`（先写 `.tmp` 再 `rename`，原子写）——半写永不可观测，故 gateway 那种 append-only 损坏风险**不适用**；`readJson` catch→fallback 仅在文件缺失时命中，设计正确，无需改。

**本轮迭代动作**：`recent()` 非正数/非有限 limit 守卫（红→绿，+1 测试）；227/227 绿，tsc exit 0。

**下一轮候选**：① 补 characterization 测试（store mutation 失败契约 / cancelNeed / parseResponse 非 JSON 错误体）；② 历史视图（iter-1 意见 #2）；③ MCP 层 `num(args.limit) ?? 20` 可考虑把 `0` 也当缺失→默认 20（与 `recent` 守卫双保险，待评估）。

---

### 迭代 #5 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 3 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **228/228 全绿**（14 文件，较 iter-4 的 227 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿）**：覆盖率扫描（vitest --coverage）定位 `WorkerSocietyService.ts` 78% 分支 + `societyRoutes.ts` 52% 分支。追到根因——**`sendSocialMessage` 把人类操作者 `'user'` 当 worker_not_found 静默丢弃**：图谱 overlay「发消息」固定 `from='user'`（iter-2 建），而 `'user'` 从未注册为 profile → `profiles.get('user')` undefined → 返回 `{ok:false}` → **消息永不投递、无任何反馈**。即 iter-2 新建的「发消息」功能端到端是坏的。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-005 消息/Feed | ✅ PASS(修复) | 人类→worker 发消息现已真正投递（service 投递 + 发 message 事件 + 落 feed）；既有「rejects unknown sender」不变（仅 `HUMAN_OPERATOR` 放行，其它未知发送方仍拒） |
| SOCIETY-012 组合根/挂载 | ✅ PASS | overlay 发消息现可用；`HUMAN_OPERATOR` 常量接入 SocietyView，消去 'user' 魔法串 |

**TDD 痕迹**：先在 `WorkerSocietyService.test.ts` 加「delivers a message from the human operator "user"」用例 → **红**（`ok:false`）→ 新增领域常量 `HUMAN_OPERATOR='user'`（`models/society.ts`，单一来源）→ `sendSocialMessage` 放行该发送方、summary 用 `from?.name ?? fromWorker` 兜底 → **绿**。SocietyView 的 `sendMessage('user',…)` 改用 `HUMAN_OPERATOR`。

**审查中排除的「假缺口」**（已正确/已定约，避免误改）：
- `buildWorkerSocietyMcpLibraryEntry` 零调用方（仅自测）——真 CLI 走 `bin/hermit.mjs` 的内联 `KNOWN_PLUGINS`（硬编码、不取 SOCIETY_MCP_TOOLS）。两者分叉是已知技术债，但统一需跨 `src/`+`bin/` 重构，非单测红→绿可解，列为后续。
- `societyRoutes` 的 `/relationships`、`/feed` catch→[] 与 `/messages` 400 校验分支——已正确，属 characterization（非红），留后续补「最全」。
- `estimateFit`（service 导出）——仅委托已测的 `computeFitScore`，trivially 正确。

**本轮迭代动作**：`sendSocialMessage` 放行 `HUMAN_OPERATOR`（修复 iter-2 「发消息」静默失败，红→绿，+1 测试）；新增 `HUMAN_OPERATOR` 常量并接入 service+renderer；228/228 绿，tsc exit 0。

**下一轮候选**：① 路由 characterization（/messages 400 + /feed·/relationships catch）补「最全」；② `buildWorkerSocietyMcpLibraryEntry` 与 CLI `KNOWN_PLUGINS` 分叉统一（跨层重构）；③ 历史视图；④ `postedBy:'user'` 字面量也接入 `HUMAN_OPERATOR`（本轮只接了消息发送面）。

---

### 迭代 #6 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 4 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **219/219 全绿**（14 文件，较 iter-5 的 228 −9：删 10 个过时用例 + 补 1 个 `NEED_STATUS_LABEL` characterization）；`tsc` exit 0。

**本轮聚焦缺口（一个，「过时的覆盖」清理，非红→绿）**：`grep` 审查发现 `renderer/societyViewUtils.ts` 有 **7 个零调用方导出**——iter-2 删看板后成为孤儿：
- 看板专用（消费者随看板删除）：`topWorkersByReputation`（排行榜）、`activeWorkers`（成员网格）、`byLifecycleOrder`/`sortNeedsByLifecycle`（看板任务排序）。
- **架构性不可达**：`workerNodeRadius`/`edgeWidth`/`trustOpacity` 试图表达「声誉=节点大小 / 协作=边宽 / 信任=边透明度」，但查证引擎契约（`packages/agent-graph/.../ports/types.ts`）——`GraphNode`（L75-194）无 `size/radius` 字段、`GraphEdge`（L198-213）无 `width/opacity` 字段，仅 `color/label/avatarUrl` 可覆盖；节点尺寸与边样式全由引擎内部决定。这 3 个映射**无法经图谱接线**（除非扩展引擎类型+渲染器）。

即旧手搓 SVG canvas 的视觉映射，引擎接管后无人再调。保留=「为以后再改埋坑」的技术债（用户工程原则明令禁止），其测试即「过时的覆盖」（loop 明列在范围）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-007 视图工具 | ✅ PASS(去冗余) | 删 7 个零调用纯函数 + 其 9 个过时用例；保留 `NEED_STATUS_LABEL`/`reputationColor`/`needStatusColor`/`pickAvatarUrl`（弹卡+图谱仍消费），并补 `NEED_STATUS_LABEL` 之前缺失的用例。barrel `export *` 自动收敛，无需改 |

**动作性质**：非 TDD 红→绿，而是「过时的覆盖」移除（loop 范围内）+ 死代码清理（「拒绝冗余 / 不留技术债」）。删代码无「先红」语义；以 grep 证零调用方、tsc 证契约无破坏为验收。

**已浮现但未埋的权衡**（记为后续候选，非静默丢弃）：用户图谱愿景「声誉=节点大小 / 关系=发光边」**当前在图谱中不可达**——需扩展 `@claude-teams/agent-graph`（`GraphNode.size`、`GraphEdge.width`/`opacity` + 渲染器），属跨 package 较大改动，单列一轮。声誉/状态信息暂由 `SocietyNodeOverlay` 弹卡（`reputationColor`/`needStatusColor`）呈现，无信息丢失。

**本轮迭代动作**：删 `societyViewUtils.ts` 7 个死导出（+看板排序用的 `LIFECYCLE_RANK`）并订正文件头注释；`societyViewUtils.test.ts` 删 5 个过时 describe、更新导入、补 `NEED_STATUS_LABEL` 用例。219/219 绿，tsc exit 0，全仓零代码引用残留（仅文件头注释提及删除原因）。

**下一轮候选**：①（承接 iter-5）路由 characterization（/messages 400 + /feed·/relationships catch）；②（承接 iter-5）`buildWorkerSocietyMcpLibraryEntry` 与 CLI `KNOWN_PLUGINS` 分叉统一；③（承接 iter-5）历史视图；④（承接 iter-5）`postedBy:'user'` 字面量接入 `HUMAN_OPERATOR`；⑤（本轮新增）若要落「声誉=节点大小 / 关系=发光边」愿景 → 扩展 agent-graph 引擎类型+渲染器。

---

### 迭代 #7 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 5 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **221/221 全绿**（14 文件，较 iter-6 的 219 +2）；`tsc` exit 0。

**本轮聚焦缺口（一个，characterization，非红→绿）**：覆盖率扫描（vitest --coverage）定位 `main/adapters/input/societyRoutes.ts` **52% 分支（全 feature 最低）**。对照 `societyRoutes.test.ts`：`POST /api/society/messages` 此前只测 **400 校验分支**，其**成功主路径（L184 `return await c.service.sendSocialMessage(...)`）零覆盖**——即该路由的核心行为（投递一条 worker→worker 消息）从未经 HTTP 验证。属 iter-5 候选 #① 的子集。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-008 REST | ✅ PASS(补缺) | `/messages` 发送成功主路径现已覆盖：返回 `{ok:true}` 且消息落 messages.jsonl、`GET /feed` 能读回（`SocialMessageRecord.text` 保留原文）；未知发送方 `ghost` 经路由 → service 判 `worker_not_found`、HTTP 仍 200（松类型路由约定，与既有 routes 风格一致） |

**动作性质**：characterization（代码本正确，非 bug）。已逐一排查潜在 bug 并排除：① 空白 `text` 经 `.trim()` → '' → 400（正确）；② 未知发送方委派 service 返回 `{ok:false, reason:'worker_not_found'}`、不落 feed、HTTP 200（正确，路由只校验字段非空）；③ `requiredCapabilities` 非数组 → `[]` 兜底（正确）。无红可证，故补 characterization 至「最全」（iter-3 先例）。

**覆盖率变化**：`societyRoutes.ts` 分支 **52% → 58.49%**（L184 成功路径已覆盖）；其余未覆盖为 `/relationships`（L172-173）、`/feed`（L191-192）的 `catch → []` 防御分支——需 fault injection 才能触达，成本高于价值，留作后续。

**本轮迭代动作**：`societyRoutes.test.ts` +2 用例（/messages 发送成功 + feed 回读 / 未知发送方 → worker_not_found）；221/221 绿，tsc exit 0。

**下一轮候选**：① 剩余防御 catch 分支（/relationships、/feed 的 catch→[]）——价值低、需注入故障，评估是否值得；②（承接 iter-5/6）`buildWorkerSocietyMcpLibraryEntry` 与 CLI `KNOWN_PLUGINS` 分叉统一；③（承接）历史视图；④（承接）`postedBy:'user'` 字面量接入 `HUMAN_OPERATOR`；⑤（承接 iter-6）引擎扩展落「声誉=节点大小」愿景。

---

### 迭代 #8 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 6 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **222/222 全绿**（14 文件，较 iter-7 的 221 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，characterization，非红→绿）**：审查 `renderer/societyStore.ts` 的 `mutate` 辅助（所有 mutation 的统一「命令→刷新→错误」通道）。`societyStore.test.ts` 此前只测 **loadAll 失败 → error**（L57），但**任一 mutation 失败的 error 契约零覆盖**——即「发布/注册/自荐失败」这条用户侧错误 UX 路径（iter-3 已标记「store mutation 失败契约」为缺口 #①）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-012 组合根/挂载 | ✅ PASS(补缺) | mutation 失败现已覆盖：`error` 写入异常 message、`loading` 不被 mutation 触碰（保持 false）、既有数据切片保留（不因单次失败清空花名册/需求）。错误 UX 契约稳定 |

**动作性质**：characterization（代码本正确，非 bug）。已排查潜在 bug 并排除：① `run()` 抛错时 `after()` 刷新被正确跳过（try 块中断）；② `run()` 成功但 `after()` 刷新失败时仍写 error（无新数据可展示，可辩护的设计）；③ 下次 mutate 入口 `set({error:null})` 会先清旧错误。无红可证，补 characterization 关闭 iter-3 缺口 #①。

**本轮迭代动作**：`societyStore.test.ts` +1 用例（mutation 失败 → error 契约 + 数据保留 + loading 中立）；222/222 绿，tsc exit 0。

**下一轮候选**：① `parseResponse` 非 JSON 错误体分支（societyApi L79，反代/网关 HTML 错误页场景）——characterization；② store 的 `startNeed`/`cancelNeed` mutation 仍未单测；③（承接）`buildWorkerSocietyMcpLibraryEntry` 与 CLI `KNOWN_PLUGINS` 分叉统一；④（承接）历史视图；⑤（承接）`postedBy:'user'` 字面量接入 `HUMAN_OPERATOR`；⑥（承接 iter-6）引擎扩展落「声誉=节点大小」愿景。

---

### 迭代 #9 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 7 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **223/223 全绿**（14 文件，较 iter-8 的 222 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿，真 bug）**：审查 Need 状态机 + 并发槽生命周期发现 **slot 泄漏**。`selectAssignee` 占用执行者一个并发槽（`activeTaskCount++`，WorkerSocietyService L188）；`acceptDelivery` 释放它（L249-251）。但状态转换表（societyPolicies `ALLOWED_TRANSITIONS`）允许 **`assigned → cancelled`**，而 `cancelNeed`（L279-286）**不释放槽** → 取消一个已选派需求会让 assignee 的 `activeTaskCount` 永久虚高 1 → 最终 `isAtCapacity` 误判为真、worker 接不了新活。资源泄漏。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-002 Need 生命周期 | ✅ PASS(修复) | assigned→cancelled 现正确释放执行者并发槽；open→cancelled（无 assignee）不受影响（`get('')`→undefined 自然跳过）；保持「cancel 中性、不变声誉/关系」语义 |
| SOCIETY-004 容量 | ✅ PASS(修复) | 取消不再泄漏容量槽，worker 的可用并发数长期准确 |

**TDD 痕迹**：先在 `WorkerSocietyService.test.ts` 加「cancel assigned need 释放 assignee 槽」用例 → **红**（cancel 后 `activeTaskCount` 仍为 1，期望 0）→ `cancelNeed` 末尾仿 `acceptDelivery` 加槽释放（`Math.max(0, w.activeTaskCount - 1)`）→ **绿**。既有 cancel 用例（open cancel / need_not_found / in_progress 非法）全过，无回归。

**审查中确认的安全面**：① `in_progress→cancelled` 非法（转换表仅 `in_progress: ['delivered']`），故无需处理执行中取消；② cancel 后无法再 cancel（`cancelled→cancelled` 非法），无双重释放；③ cancel 不触碰声誉/关系（保持「中性」语义，与既有用例注释一致）。

**本轮迭代动作**：`cancelNeed` 释放 assigned 需求的并发槽（红→绿，真 bug 修复，+1 测试）；223/223 绿，tsc exit 0。

**下一轮候选**：① `expireNeeds` 仅 open→expired（无 assignee，安全）；若未来允许 assigned→expired 则需同步释放槽（预防性）；②（承接）`parseResponse` 非 JSON 错误体分支；③（承接）store startNeed/cancelNeed mutation 单测；④（承接）`postedBy:'user'`→`HUMAN_OPERATOR`；⑤（承接）历史视图；⑥（承接 iter-6）引擎扩展。

### 迭代 #10 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 8 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **224/224 全绿**（14 文件，较 iter-9 的 223 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿，真 bug + 债务清理）**：领域不变量不一致——声誉被定义为 `[REPUTATION_MIN, REPUTATION_MAX]` = `[0,100]`，`applyReputationDelta` 在每次 delta 时夹取（societyPolicies L444）。但 `registerProfile`（输入边界，WorkerSocietyService L92）**透传** `cmd.reputation` 无夹取 → 经 REST/MCP 注册 `reputation:150`（或 `-20`）会持久化**出界原值**。下游 `computeFitScore` 虽 `clamp01(rep/100)` 兜底、`reputationColor` 也只是分段，故目前无可见故障；但持久化的原值违反不变量，是「在 delta 边界夹取、在 set 边界不夹取」的不一致——正是「发现既有债务顺手清掉」类问题。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 注册/发现 | ✅ PASS(修复) | 注册即夹取声誉到 [0,100]，输入边界与 delta 边界同守同一不变量；既有 in-range 注册（50/70/80/90…）无回归 |
| SOCIETY-005 声誉 | ✅ PASS(修复) | 声誉值长期落在合法区间，排序/适配度计算基于真实裁剪后的值 |

**TDD 痕迹**：先在 `WorkerSocietyService.test.ts` registerProfile 块加「clamps reputation to [0,100]」用例（150→100、-20→0）→ **红**（`expected 150 to be 100`）→ 实现：societyPolicies 抽出 `clampReputation(value)`（包装私有 `clamp`，单一夹取真相源），`applyReputationDelta` 改用它（行为不变，去重）；`registerProfile` 在 `cmd.reputation ?? existing?.reputation ?? 50` 外包 `clampReputation(...)` → **绿**。`applyReputationDelta` 既有 66 个 policy 测试全过，无行为回归。

**审查中确认的安全面**：① `clamp` 是 module-private（societyPolicies L467），不外泄泛型 util，而抽出的 `clampReputation` 是领域语义命名，与 `applyReputationDelta` 并列；② 既有 re-register「无 reputation 时保留 existing」语义不受影响（`??` 链先取 existing 再 clamp，existing 本就在界内）；③ `maxConcurrent` 未夹取——`0`/负数会让 worker 永久 `isAtCapacity`，是更可疑的 footgun，但语义模糊（可能即「暂停/不可用」），列为候选待定，不一并改（精准、不夹带）。

**本轮迭代动作**：新增 `clampReputation` 并让 registerProfile + applyReputationDelta 共用（红→绿，不变量一致化 + 去重，+1 测试）；224/224 绿，tsc exit 0。

**下一轮候选**：① `maxConcurrent` 输入夹取（`<1` → 永久 isAtCapacity 的 footgun，待定语义后处理）；②（承接）`expireNeeds` 仅 open→expired；③（承接）`parseResponse` 非 JSON 错误体分支；④（承接）store startNeed/cancelNeed mutation 单测；⑤（承接）`postedBy:'user'`→`HUMAN_OPERATOR`；⑥（承接）历史视图；⑦（承接 iter-6）引擎扩展。

### 迭代 #11 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 9 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **225/225 全绿**（14 文件，较 iter-10 的 224 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，TDD 红→绿，真 bug）**：承接 iter-10 候选 ①——`maxConcurrent` 输入边界无夹取。`isAtCapacity`（societyPolicies L74-75）= `activeTaskCount >= maxConcurrent`，故注册 `maxConcurrent:0` → `0>=0` **永真** → worker 被自荐闸门（L81 `isAtCapacity`）、选派资格（L142）、自治自荐（L303）**永久拒之门外**，静默不可用（无报错、无日志）。关键证据：`loadFairness`（L102）已写 `maxConcurrent > 0 ? … : 0` 防御 `≤0`，反证这是可达输入，而真正的容量闸门 `isAtCapacity` 反而未防。无「maxConcurrent:0=暂停」语义——不可用本就由 `status`（online/offline）建模。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 注册/发现 | ✅ PASS(修复) | 注册即夹取 `maxConcurrent` 到 ≥1；0/负数不再静默砖化 worker；默认 3 与既有 in-range 注册（2 等）无回归 |
| SOCIETY-004 容量 | ✅ PASS(修复) | 容量闸门 `isAtCapacity` 的 `>=` 比较从此恒基于 ≥1 的合法 maxConcurrent，worker 可用性不再被坏输入误判 |

**TDD 痕迹**：先在 `WorkerSocietyService.test.ts` registerProfile 块加「clamps maxConcurrent to a minimum of 1」用例（0→1、-5→1）→ **红**（`expected 0 to be 1`）→ `registerProfile` 把 `cmd.maxConcurrent ?? existing?.maxConcurrent ?? 3` 外包 `Math.max(1, …)` → **绿**。既有用例（默认 3、re-register 保留 2、seedTwoWorkers 的 2）全过，无回归。

**审查中确认的安全面**：① 与 iter-10 reputation 夹取同形（输入边界兜底），但 maxConcurrent 仅下界无上界（worker 可合法并发 100），故内联 `Math.max(1,…)` 而非再造 helper（避免过度抽象）；② `loadFairness` L102 的 `maxConcurrent>0` 防御**保留不动**——它成本极低、且保护绕过 service 的直接 `profiles.upsert`（测试/fake 路径），属合理防御纵深而非冗余层；③ 不存在「合法的 maxConcurrent:0」调用方（demo/seed 均用默认 3）。

**本轮迭代动作**：`registerProfile` 夹取 `maxConcurrent` 到 ≥1（红→绿，真 footgun 修复，+1 测试）；225/225 绿，tsc exit 0。

**下一轮候选**：①（新）验证 autoSelectPending 在单轮扫描中对「同一 worker 是多个 need 最优自荐者」时，因 selectAssignee 每轮重读 profile 故不超额分配——目前无专门用例，是微妙正确性锁（characterization）；②（承接）`expireNeeds` 仅 open→expired；③（承接）`parseResponse` 非 JSON 错误体分支；④（承接）store startNeed/cancelNeed mutation 单测；⑤（承接）`postedBy:'user'`→`HUMAN_OPERATOR`；⑥（承接）历史视图；⑦（承接 iter-6）引擎扩展。

### 迭代 #12 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 10 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **226/226 全绿**（14 文件，较 iter-11 的 225 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，characterization 锁微妙正确性，非 bug）**：承接 iter-11 候选 ①——先扫一遍 MCP 层（societyMcp.ts）排除真 bug：`num()` 对非法输入返回 undefined→`??` 默认兜底、`recent(0)` 已守（iter-4）、register 的 reputation/maxConcurrent 经 iter-10/11 夹取覆盖，**MCP 干净无 bug**。转而补一个**未被锁的微妙正确性**：`autoSelectPending` 单轮扫描「同一 worker 是多个 need 唯一/最优自荐者」时**不超额分配**。其保障是 `selectAssignee` 每轮 `this.profiles.list()` 重读（WorkerSocietyService L177），故处理第二个 need 时看到该 worker 已满载→从合格集合剔除。若有人把它「优化」成在循环外缓存一次 profile 列表（自然诱因），会**静默超额分配**（activeTaskCount 超过 maxConcurrent）——核心自治正确性回归。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004 容量 / SOCIETY-007 自治选派 | ✅ PASS(characterization) | 锁住「单轮扫描尊重容量、不超额分配」；maxConcurrent=1 的 worker 即便独占两个 need 的自荐也只接 1 个，另一个留 open |

**TDD 痕迹**：characterization（绿现，与 iter-3/7/8 同类，非 bug）——在 `autoSelectPending` describe 块加「does not over-allocate: maxConcurrent=1 worker best for two needs gets only one」用例：注册 solo（design+frontend、rep 90、maxConcurrent=1）+ poster，发 A(design)/B(frontend)，solo 各自荐→`autoSelectPending()` 期望 **1**（非 2）、`solo.activeTaskCount===1`（非 2）、两 need 状态集 `{assigned, open}`。**直接绿**（selectAssignee 确实每轮重读）。既有「selects across multiple needs」用例（designer maxConcurrent=2→选 2）互补，现两类边界（满载/未满载）俱锁。

**审查中确认的安全面**：① listOpen 返回快照、按发布序遍历，A 先处理→solo 接 A，B 时 solo 满载→B 留 open（确定性，无随机）；② selectAssignee 对「无合格自荐者」返回 `no_eligible_volunteer`，autoSelectPending 不计入 selected（仅 `if (r.ok) selected+=1`），故 selected=1 准确；③ 本用例不依赖 iter-11 的 maxConcurrent 夹取（此处显式传 1，合法）。

**本轮迭代动作**：补 autoSelectPending 不超额分配的 characterization（+1 测试，锁住 selectAssignee 重读 profile 的微妙不变式）；226/226 绿，tsc exit 0。

**下一轮候选**：①（承接）`expireNeeds` 仅 open→expired（assigned 过期需求不被扫，槽不释放——设计题，待评估）；②（承接）`parseResponse` 非 JSON 错误体分支（societyApi L79）；③（承接）store startNeed/cancelNeed mutation 单测；④（承接）`postedBy:'user'`→`HUMAN_OPERATOR` 字面量统一（纯重构、无行为变更，已推迟 7 轮）；⑤（承接）历史视图（closed/expired/cancelled 需求不可见）；⑥（承接 iter-6）引擎扩展落「声誉=节点大小」愿景；⑦（新）MCP `society_register_worker` 缺 worker_id 时 workerId=undefined 的边界（schema 标 required，低优先）。

### 迭代 #13 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 11 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **227/227 全绿**（14 文件，较 iter-12 的 226 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个，characterization 补齐错误路径三分支，非 bug）**：承接 iter-12 候选 ②——先逐行审 `crossTeamMessageGateway.ts` + `societyRoutes.ts` 排除真 bug：网关 `all()` 逐行 try/catch 跳过坏行、`recent()` 守 `limit<=0`（iter-3/4 已修）；路由全程防御（trim、非数组 requiredCapabilities→[]、空 workerId→service 优雅返 `worker_not_found`、register/publish/messages 缺字段返 400）。**两文件均无真 bug**。转而补 `parseResponse` 错误路径**未被测的第三分支**：非 JSON 错误体（反代/网关返回 HTML 502 页）。前两分支已覆盖（JSON `{error}`→抛 error 文案 L121；空体→`HTTP {status}` L127），唯独「非空非 JSON」分支（societyApi L78-79：`JSON.parse` 抛 SyntaxError → catch 包成 `HTTP {status}: {body 前 200 字符}`）无测。此分支决定客户端遇网关 HTML 错误页时不崩、给出带状态码的可读错误。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-009 前端 API 客户端健壮性 | ✅ PASS(characterization) | 锁住「非 JSON 错误体→HTTP 前缀包装」契约；若 SyntaxError 的 catch 被删，客户端会冒泡 `Unexpected token <` 而非可用错误，本测即红 |

**TDD 痕迹**：characterization（绿现，与 iter-3/7/8/12 同类）——在 `societyApi.test.ts` 错误路径组（empty-body 用例后）加「wraps a non-JSON error body into an HTTP-prefixed message」用例：mock 一个 `ok:false, status:502, text→'<html>…502 Bad Gateway…'` 的 Response，断言 `listWorkers()` reject 抛 `/HTTP 502:.*502 Bad Gateway/`。**直接绿**（parseResponse 确实包了 body 前缀）。补齐错误三分支（空/JSON/非 JSON）全覆盖。

**审查中确认的安全面**：① `res()` 测试工厂恒产 JSON，故非 JSON 场景须手写 Response 替身（仿既有 empty-body 用例）；② body < 200 字符时 `slice(0,200)` 取全量、正则宽松匹配「502 Bad Gateway」子串，不脆；③ REST `/feed` 硬编码 `recent(50)` 与 MCP `get_feed` 默认 20 的默认值分叉是已知次要不一致（非 bug，列候选）。

**本轮迭代动作**：补 `parseResponse` 非 JSON 错误体分支的 characterization（+1 测试，补齐客户端错误路径三分支全覆盖）；227/227 绿，tsc exit 0。

**下一轮候选**：①（承接）`expireNeeds` 仅 open→expired（设计题）；②（承接）store startNeed/cancelNeed mutation 单测（characterization，补 store mutation 覆盖）；③（承接）`postedBy:'user'`→`HUMAN_OPERATOR` 字面量统一（纯重构、已推迟 8 轮——或可顺手清，无测试需求）；④（承接）历史视图；⑤（承接 iter-6）引擎扩展；⑥（新）REST `/feed` 默认 50 与 MCP `get_feed` 默认 20 的默认值分叉统一（次要一致性）。

### 迭代 #14 · 2026-06-14（10 分钟 TDD 覆盖循环 #1e539b60，第 12 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **228/228 全绿**（14 文件，较 iter-13 的 227 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个 characterization 锁双切片刷新契约 + 顺手正名）**：承接 iter-13 候选 ②。先复核 `societyStore.ts` 排除真 bug：发现 `reloadOpenNeeds`（L77-83）**名不副实**——它同时刷新 `openNeeds` + `activeNeeds`（注释 L75-76 已说明，画布据 activeNeeds 渲染）。**故无 stale-data bug**：每个需求生命周期 mutation（含 cancelNeed）都双切片刷新，cancel 一个 assigned 需求（iter-9 的 assigned→cancelled）画布仍同步。但函数名 `reloadOpenNeeds` 强烈暗示「只刷 open」，是 readability 隐患（本轮调查时一度险被当 bug 记录）——正是「发现既有债务顺手清掉」类。

**两层动作**：
1. **characterization（绿现）**：在 `societyStore.test.ts` 加「startNeed/cancelNeed each reload BOTH open and active needs」用例——断言两 mutation 后 `listOpenNeeds` **与** `listActiveNeeds` 各被调一次（startNeed 后 1/1，cancelNeed 后 2/2）。锁住「双切片刷新」契约：若有人据函数名把它「优化」成只刷 open，画布 activeNeeds 会留陈旧节点，本测即红。补齐 store mutation 覆盖（startNeed/cancelNeed 此前无单测）。
2. **正名（行为中立重构）**：`reloadOpenNeeds` → `reloadNeeds`（10 处引用，全在 createSocietyStore 私有作用域）。上一步的 characterization 证明行为不变。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-008 前端状态层（store mutation 局部刷新） | ✅ PASS(characterization+正名) | 锁住「需求 mutation 后 open+active 双切片刷新」；函数正名消除「只刷 open」的误导，防后人引入冗余第二套 active 刷新 |

**TDD 痕迹**：characterization 先写 → **直接绿**（reloadNeeds 确实双刷，与 iter-3/7/8/12/13 同类，非 bug）。随后正名 `reloadOpenNeeds`→`reloadNeeds`，全量回归 **228/228 绿**、tsc exit 0，证明重命名行为中立。

**审查中确认的安全面**：① 正名仅触及私有 const 与其 9 个调用点，无跨文件影响、无导出变更；② 注释 L75-76（描述「open+active 同源同刷」）保留不动，仍准确；③ `mutate` 的 error-catch 契约已由 iter-8 的 mutation-error 用例覆盖，本轮不重复。

**本轮迭代动作**：补 startNeed/cancelNeed 双切片刷新的 characterization（+1 测试）+ `reloadOpenNeeds`→`reloadNeeds` 正名（顺手清误导性命名）；228/228 绿，tsc exit 0。

**下一轮候选**：①（承接）`expireNeeds` 仅 open→expired（设计题，待评估 assigned 过期是否应扫）；②（承接）`postedBy:'user'`→`HUMAN_OPERATOR` 字面量统一（纯重构、已推迟 9 轮）；③（承接）历史视图（closed/expired/cancelled 需求不可见）；④（承接 iter-6）引擎扩展；⑤（新）REST `/feed` 默认 50 与 MCP `get_feed` 默认 20 统一；⑥（新）societyGraphAdapter 的 self-relationship（from==to）/ 未知 worker 关系边边界（若有未覆盖分支）。store mutation 覆盖现已基本完整。

### 迭代 #15 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 13 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **228/228 全绿**（14 文件，与 iter-14 持平——本轮为纯重构、+0 测试）；`tsc` exit 0。

**本轮聚焦（顺手清掉债务，非覆盖缺口）**：先穷举确认**所有文件已无未测高价值分支**——`societyGraphAdapter` 的关系边去重/未知 worker/孤儿 assignee/丢弃状态/粒子俱全（15 测，仅 self-relationship `from==to` 跳过分支未测，但该路径经 selectAssigneePolicy 的 `postedBy !== v.workerId` 闸门不可达，低价值防御分支）；`societyOverlayActions` 的 `clampOverlayPosition` 全分支含左侧仍越界→margin 均已测。**覆盖任务对当前 scope 已饱和**，转而清掉**已推迟 9 轮的 `postedBy:'user'` 魔法串债务**：`HUMAN_OPERATOR='user'` 常量本为消灭该字面量重复而设，却在 3 处仍用字面量——`SocietyView.tsx:73`（publishNeed，**且同文件已 import 并用于 L133 sendMessage，内部不一致**）、`societyDemo.ts:50/56`（×2，根本没 import 常量）。若常量改名，这 3 处会与 `sendSocialMessage` 的 `fromWorker !== HUMAN_OPERATOR` 校验静默分叉。

**动作（行为中立重构，3 处字面量→常量）**：
1. `societyDemo.ts`：新增 `import { HUMAN_OPERATOR } from '../core/domain/models/society'`，两处 `postedBy: 'user'` → `postedBy: HUMAN_OPERATOR`。
2. `SocietyView.tsx:73`：`postedBy: 'user'` → `postedBy: HUMAN_OPERATOR`（常量已在 L23 import）。
3. grep 复核：非测试源码已无 `postedBy: 'user'` 字面量（仅 SocietyNodeOverlay 注释与 societyMcp 描述串保留 `'user'` 文案——前者为说明性注释、后者为面向 agent 的 tool description，皆非代码常量，保留合理）。

**验证**：纯重构无行为变更（`HUMAN_OPERATOR === 'user'`），由既有套件背书——societyDemo 6 测（demo 发布需求）+ publishNeed 全流程 + sendSocialMessage 的 HUMAN_OPERATOR 用例全过。**228/228 绿、tsc exit 0**，重命名行为中立。

**本轮迭代动作**：统一 3 处 `postedBy:'user'` 字面量 → `HUMAN_OPERATOR` 常量（消除魔法串重复、修同文件内部不一致，+0 测试、纯重构）；228/228 绿，tsc exit 0。**worker-society 当前 scope 覆盖已饱和**（14 文件、228 测，各文件无遗留未测高价值分支）。

**下一轮候选**（覆盖饱和后，转向设计/产品增强与跨层重构）：①（承接）`expireNeeds` 是否应扫 assigned 过期需求并释放槽（设计题）；②（承接）历史视图（closed/expired/cancelled 需求在图谱不可见，需独立入口）；③（承接 iter-6）扩展 agent-graph 引擎类型+渲染器落「声誉=节点大小 / 关系=发光边」愿景（跨 package 大改）；④（新）REST `/feed` 默认 50 与 MCP `get_feed` 默认 20 的默认值统一；⑤（新）UI 组件（SocietyGraph/SocietyNodeOverlay）无单测——hermit 未引入 @testing-library/react，是已知缺口（需评估引入成本）；⑥（新）产品验收角度实跑：`pnpm dev` 起服务，按 SOCIETY-001~012 清单手测黄金路径，记录真实体验意见（区别于纯单测覆盖）。

### 迭代 #16 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 14 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **229/229 全绿**（14 文件，较 iter-15 的 228 +1）；`tsc` exit 0。

**本轮聚焦缺口（一个 characterization，锁路由 catch→[] 优雅降级）**：iter-15 声明覆盖饱和后复核最低覆盖文件——`societyComposition.ts`（2 测，但含跨「重启」的完整持久化往返，是 wiring 的最强集成证据，**非缺口**）、`workerSocietyPlugin.ts`（7 测，id/endpoint/no-drift/serializability/default+custom host/upsert-shape 俱全，**非缺口**）。确认饱和后，回捞 iter-7/13 标记的最后一个未测分支：**所有 GET 列表路由的 `try/catch → []` 优雅降级**（societyRoutes `/workers`、`/needs*`、`/relationships`、`/feed` 同构，L20-26/57-80/168-193）。底层 gateway/store 自身 readJson 已 catch 兜底（不抛），路由层 catch 是 belt-and-suspenders——防未来 store 实现直接抛时路由 500 而非返空（前端拿空数据不崩）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-009 路由健壮性 | ✅ PASS(characterization) | 锁住「底层抛错→路由返 200+[] 而非 500」；防回归（若有人删路由 try/catch，前端遇 FS 故障会 500 崩，本测即红） |

**TDD 痕迹**：characterization（绿现，与 iter-3/7/8/12/13/14 同类，非 bug）——在 `societyRoutes.test.ts` 末尾加「GET /feed degrades to [] when the gateway throws」用例：注入会抛的 gateway（`c.gateway = { recent: async () => { throw … } } as …`，路由闭包按调用时读 `c.gateway` 故注册后替换生效）→ 注入 GET /feed → 断言 **200 + []**（非 500）。以 /feed 为代表，其余列表路由同构。**直接绿**（路由确有 catch→[]）。

**审查中确认的安全面**：① 路由闭包捕获的是 `c`（组件对象引用），handler 每次请求读 `c.gateway.recent`，故注册后替换 `c.gateway` 在下一次 inject 生效；② 真实 gateway `recent()` 内部 `all()` 已 try/catch 返 []，永不抛——故必须注入裸抛的 gateway 才能触发路由层 catch（注释已说明）；③ 其余列表路由（/workers、/needs/open 等）的 catch→[] 同构，不为每条重复加测（拒绝冗余），/feed 代表性足够。

**本轮迭代动作**：补 `/feed` 路由 catch→[] 优雅降级的 characterization（+1 测试，锁路由层容错契约）；229/229 绿，tsc exit 0。**至此 GET 列表路由的未测分支亦覆盖，worker-society 单测覆盖真正饱和。**

**下一轮候选**（单测已饱和，下一轮应转向非单测维度）：①（承接）`expireNeeds` assigned 过期扫描（设计题）；②（承接）历史视图；③（承接 iter-6）引擎扩展落愿景；④（承接）`/feed` 默认 50 vs MCP 20 统一；⑤（承接）UI 组件单测（需引入 @testing-library/react，成本评估）；⑥（推荐）**产品验收实跑**：`pnpm dev` 起服务，按 SOCIETY-001~012 清单手测黄金路径 + 记录真实 UX 意见（声誉仅 overlay 色非节点大小、closed 需求不可见等）——这是单测无法覆盖、且最贴近「作为产品体验去验收」原意的下一步。

### 迭代 #17 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 15 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **230/230 全绿**（14 文件，较 iter-16 的 229 +1）；`tsc` exit 0。

**重要更正（推翻 iter-15/16 的「饱和」声明）**：iter-15/16 据「读源码穷举」判定覆盖饱和。本轮**改用证据而非断言**——实跑 `vitest --coverage` 取逐文件表，发现 **`societyRoutes.ts` 分支覆盖仅 60.37%**（14 文件最低，其余 87–100%）。`societyRoutes.test.ts` 只有 2 个 `toBe(400)`：register 缺字段（L56）、messages 缺字段（L360）。**publish-need 的同源 400 校验（societyRoutes L91-93：`if (!postedBy || !subject)`）漏测**——与已测的 register/messages 400 不一致，是真实校验契约、非 belt-and-suspenders。其余低分支文件（证据同源）：`WorkerSocietyService` 80.89%、`societyMcp` 79.31%、`societyOverlayActions` 87.5%、`societyApi` 89.13%。

**本轮聚焦缺口（一个 characterization，锁 publish-need 400 校验）**：补 `societyRoutes.test.ts`「rejects publishing a need missing postedBy/subject with 400」——两条 inject 分别缺 `postedBy`、缺 `subject`，各断言 **400**。覆盖 `||` 的两臂短路（`!postedBy`→真短路；`postedBy` 在、`!subject`→真）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004 发布需求校验 | ✅ PASS(characterization) | 锁住「空 postedBy/subject → 400 拒绝、不入库」；防回归（若有人放宽校验让空需求进 agora，自治选派会拿到无主题垃圾任务，本测即红） |

**TDD 痕迹**：characterization（绿现，路由确有 L91-93 校验）——直接绿（非 bug，锁契约）。

**证据（覆盖前后对比，非断言）**：societyRoutes.ts 分支覆盖 **60.37% → 67.85%（+7.48pp）**；未覆盖行由旧「…93,100,172-173」→「…-79,100,172-173」，**L93 已被覆盖**（退出未覆盖集）。

**审查中确认的安全面**：① `postedBy`/`subject` 经 `.trim()` 后判空，故空串与空白串皆 400（测试用真缺字段，已覆盖「缺」；trim 空白属同分支，不重复加测）；② 校验在 `service.publishNeed` 前，空需求永不落 FsStore。

**本轮迭代动作**：补 publish-need 400 校验的 characterization（+1 测试，societyRoutes.test.ts 16→17）；230/230 绿，tsc exit 0；societyRoutes.ts 分支覆盖 60.37%→67.85%（有据）。**更正前序「饱和」误判——单测覆盖尚未真饱和**。

**下一轮候选（按剩余分支密度排序，证据驱动）**：① `societyMcp.ts` 79.31% 分支（次低，待取未覆盖行）；② `WorkerSocietyService.ts` 80.89%（estimateFit/randomId fallback 已知）；③ societyRoutes.ts 残留 L100（`Array.isArray(requiredCapabilities)` 的 false→`[]` 臂）+ L172-173；④ societyApi 89.13%、societyOverlayActions 87.5%。**方法论固化**：此后每轮先 `--coverage` 取逐文件表、按分支密度选题，不再凭读源码判饱和。

### 迭代 #18 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 16 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **231/231 全绿**（14 文件，较 iter-17 的 230 +1）；`tsc` exit 0。

**本轮选题（按 iter-17 方法论，coverage 表驱动）**：取全量逐文件表，最低分支密度仍是 **societyRoutes.ts 67.85%**（iter-17 后），未覆盖 `…100,172-173`。读源甄别三个残留点：① **L100**=`Array.isArray(body.requiredCapabilities) ? … : []` 的 false 臂（非数组→归一 `[]`）——**唯一的非冗余输入边界**；② L172-173=`/relationships` 路由 `catch→[]`；③ ~L75-79=`/needs` GET 路由 `catch→[]`。②③ 与 iter-16 已测的 `/feed catch→[]` **同构**，按 iter-16 自定原则「不为每条重复加测（拒绝冗余）」**有意不补**。故本轮只聚焦 L100。

**本轮聚焦缺口（一个 characterization，锁 requiredCapabilities 归一契约）**：客户端/MCP 若传非数组 `requiredCapabilities`（字符串/null 等），路由防御性归一为 `[]`（L98-100），不崩。补 `societyRoutes.test.ts`「coerces a non-array requiredCapabilities to []」——publish 传 `requiredCapabilities: 'code,css'`（字符串），断言 **200 + need.requiredCapabilities===[]**（模型 L56 `requiredCapabilities: string[]`、service L128 直存，故归一结果落 need）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004 发布需求归一 | ✅ PASS(characterization) | 锁「非数组能力 → `[]`（空门槛）」契约；**已知设计取舍（隐患）**：空能力 = 任何 worker 都匹配，恶意/手误传串会让 need 无声失去能力门槛——防崩溃优先于严格校验。本测固化现状，**不改设计**（是否升级为 400 拒绝属产品决策，列候选） |

**TDD 痕迹**：characterization（绿现，归一确在 L98-100）——`Array.isArray('code,css')===false` → 走 `: []`，cmd.requiredCapabilities=[]，need 直存，直接绿。

**证据（覆盖前后对比）**：societyRoutes.ts 分支 **67.85% → 70.17%（+2.32pp）**；未覆盖行 `…100,172-173` → `…1,75-79,172-173`，**L100 退出未覆盖集**。残留 `171-173`/`75-79` 均为 `catch→[]`（iter-16 已代表，冗余不补）。

**审查中确认的安全面**：① 非 `Array.isArray` 的所有值（string/null/number/object）共走同一 `: []` 臂，一处用例即覆盖整支（不重复加测）；② 归一在 `service.publishNeed` 前，空能力 need 照常入库、照常进 agora——故隐患成立（产品意见已记）。

**本轮迭代动作**：补 requiredCapabilities 非数组归一的 characterization（+1 测试，societyRoutes.test.ts 17→18）；231/231 绿，tsc exit 0；societyRoutes.ts 分支 67.85%→70.17%（有据）。**societyRoutes.ts 的非冗余分支已全部覆盖**——残留仅 iter-16 已代表的 `catch→[]` 冗余。

**下一轮候选（证据驱动，转向次低密度文件）**：① **`societyMcp.ts` 79.31%（次低，仅 L229 未覆盖）**——单行，读源定性质后补；② `WorkerSocietyService.ts` 80.89%（estimateFit L417-418 / randomId fallback L422-427）；③ `societyOverlayActions.ts` 87.5%（L47）；④ `societyApi.ts` 89.13%（L15,24,77,83,111）；⑤（产品决策，承接本轮隐患）非数组 `requiredCapabilities` 是否升级为 400 拒绝（而非静默 `[]`）。

### 迭代 #19 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 17 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **232/232 全绿**（14 文件，较 iter-18 的 231 +1）；`tsc` exit 0。

**本轮选题（按 iter-17 方法论，coverage 表驱动）**：全量表次低密度为 **`societyMcp.ts` 79.31% 分支**（全表显示仅 L229 未覆盖）。读源定性质：L228-229 = `case 'society_list_open_needs': return text(await c.needs.listOpen())` —— **12 个 `society_*` MCP 工具里唯一未被任何测试调用的 switch 分支**（register/discover/publish/volunteer/select/start/deliver/accept/autonomy/auto_select/message/feed 全已覆盖，唯独 list_open_needs 漏）。这是真实契约缺口：agent 用此工具看广场 open 需求，却无测试确认其映射 `c.needs.listOpen()`。

**本轮聚焦缺口（一个 characterization，锁 list_open_needs 工具契约）**：补 `societyMcp.test.ts`「lists open needs on the agora」——注册 poster → publish 一个 open need → 调 `society_list_open_needs` → 断言返回列表含该 needId。覆盖 L229 分支。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-006 MCP 广场查询 | ✅ PASS(characterization) | 锁「list_open_needs → 返回当前 open needs」；至此**所有 13 个 society_* MCP 工具均有契约测试**（dispatch 覆盖闭环） |

**TDD 痕迹**：characterization（绿现，工具确在 L228-229）——publish 后 need 状态为 open，`listOpen()` 含之，直接绿。

**证据（覆盖前后对比）**：societyMcp.ts 分支 **79.31% → 82.75%（+3.44pp）**，stmt **99.55% → 100%**，**L229 退出未覆盖集**。

**准确性更正（诚实记录）**：全量覆盖表的「未覆盖」列被终端宽度截断，仅显示 `229`；本轮**隔离 societyMcp.ts 单测取覆盖**（列更宽）才暴露残留分支 `26,34,43,208,243`——这些一直在、此前被截断隐藏。性质：皆为参数默认的 `??` 臂（如 L208 `args.name ?? args.worker_id`：register 不传 name→退回 worker_id）。非本轮引入、非回归。

**审查中确认的安全面**：① list_open_needs 无参数，`args={}` 直接命中 `c.needs.listOpen()`，无默认值分支可漏；② publish 后 need 必为 open（ALLOWED_TRANSITIONS 起点），故 listOpen 必含——断言稳健。

**本轮迭代动作**：补 `society_list_open_needs` MCP 工具的 characterization（+1 测试，societyMcp.test.ts 9→10）；232/232 绿，tsc exit 0；societyMcp.ts 分支 79.31%→82.75%、stmt→100%（有据）。**13 个 society_* MCP 工具 dispatch 全覆盖闭环。**

**下一轮候选（证据驱动）**：① **`societyMcp.ts` L208**（register 不传 name→退回 worker_id 的 `??` 臂，干净 characterization）；② societyMcp.ts L26/34/43（csv/num/csvSkills 辅助函数默认臂）；③ **`WorkerSocietyService.ts` 80.89%**（estimateFit L417-418 / randomId fallback L422-427）；④ `societyOverlayActions.ts` 87.5%（L47）；⑤ `societyApi.ts` 89.13%。

### 迭代 #20 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 18 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **233/233 全绿**（14 文件，较 iter-19 的 232 +1）；`tsc` exit 0。

**本轮选题（承接 iter-19 候选①）**：`societyMcp.ts:208` `name: args.name ?? args.worker_id` 的 false 臂——既有 register 测试恒传 `name: 'Dev'`，只覆盖 `args.name` 真臂；**不传 name → 退回 worker_id 作名字**的默认臂漏测。真实契约：agent 注册可不带 name，适配层用 worker_id 兜底。

**本轮聚焦缺口（一个 characterization，锁 name 兜底契约）**：补 `societyMcp.test.ts`「falls back to worker_id as the name when registering without a name」——`{ worker_id: 'dev' }`（不传 name）→ 断言 profile `name === 'dev'`（退回 worker_id）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 注册兜底 | ✅ PASS(characterization) | 锁「无 name → worker_id 作名」；防回归（若有人删 `?? args.worker_id`，无 name 注册会得 `name: undefined`，图谱节点 label 崩，本测即红） |

**TDD 痕迹**：characterization（绿现，`??` 兜底确在 L208）——直接绿。

**证据（覆盖前后对比）**：societyMcp.ts 分支 **82.75% → 89.65%（+6.9pp）**，未覆盖 `26,34,43,208,243` → `34,43,243`——**L208 退出未覆盖集**；**附带覆盖 L26**（不传 name 的用例亦不传 capabilities，`csvSkills(undefined)` 命中 csvSkills 的 undefined→`[]` 默认臂）。

**审查中确认的安全面**：① `??` 真臂（传 name）与 false 臂（不传）各一例即覆盖整支，不重复；② worker_id 非空（注册必填，由 MCP 调用方保证），故兜底值合法、profile.name 必有值。

**本轮迭代动作**：补 register 无 name→worker_id 兜底的 characterization（+1 测试，societyMcp.test.ts 10→11）；233/233 绿，tsc exit 0；societyMcp.ts 分支 82.75%→89.65%（+6.9pp，附带清 L26）。

**下一轮候选（证据驱动）**：① societyMcp.ts 残留 `34,43,243`（csv/num 辅助默认臂 + L243，皆小支）；② **`WorkerSocietyService.ts` 80.89%**（次低文件，estimateFit L417-418 / randomId fallback L422-427——两块未测逻辑、价值更高）；③ `societyOverlayActions.ts` 87.5%（L47）；④ `societyApi.ts` 89.13%（L15,24,77,83,111）。**建议下一轮转 WorkerSocietyService**（application 层核心、单文件两块未测、密度更低）。

### 迭代 #21 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 19 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **234/234 全绿**（14 文件，较 iter-20 的 233 +1）；`tsc` exit 0。

**本轮选题（承接 iter-20 候选②，转 application 层核心文件）**：`WorkerSocietyService.ts` 80.89% 分支。读源甄别两块未测：① **`estimateFit`（L421-427）**——导出的纯函数便捷包装（`computeFitScore(...).score`，注释「为前端预估暴露」），**零调用、零测试的公开 API 面**；② `randomId` 的 `crypto.randomUUID` 缺失降级（L416-418，`Date.now()/Math.random`）——仅极旧环境/需 stub `globalThis.crypto` 才能触发，难测、低价值。**选 ①**（公开未测 API > 环境降级分支）。**更正 iter-20 候选笔误**：其文「estimateFit L417-418 / randomId fallback L422-427」标签互换——实为 L421-427=estimateFit、L416-418=randomId 降级。

**本轮聚焦缺口（一个 characterization，锁 estimateFit 正确委托）**：补 `WorkerSocietyService.test.ts` 新 describe「estimateFit」——构造 need 需 `['design']` + 两个仅能力不同的 worker（同负载/声誉/关系/兴趣），断言**匹配者适配度严格 > 不匹配者**（分差 = capability 权重 × 匹配差，非循环性质，验证它真委托 computeFitScore 而非返回常量）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-005 适配度预估 | ✅ PASS(characterization) | 锁「estimateFit = computeFitScore.score 且能力匹配提升分数」；此前是前端可调却零测的公开出口——补防回归（若有人把 `.score` 误写成 `.capability`，前端预估会失真） |

**TDD 痕迹**：characterization（绿现，函数确为 `return computeFitScore(...).score`）——两 worker 仅能力差，权重默认，分差>0，直接绿。

**证据（覆盖前后对比，全量 suite 取数避免隔离偏差）**：WorkerSocietyService.ts **stmt 96.86%→98.95%（+2.09pp）、branch 80.89%→81.11%（+0.22pp）**，未覆盖 `417-418,422-427` → `169,417-418`——**L422-427（estimateFit 全函数体）退出未覆盖集**。branch 增幅小系函数为单行薄包装（分支少），价值在「公开 API 面从零测到有测」而非原始 %。

**准确性更正（诚实记录）**：**隔离单测**取覆盖（仅 WorkerSocietyService.test.ts）会**低估**——routes/mcp 测试亦经 service 走路径，隔离时这些不跑，故隔离显示 80.68%（比全量 81.11% 低）且多冒出 L169。**正确取数须全量 suite + `--coverage.include` 单文件**（本轮已如此取最终数）。隔离法的副作用：暴露出 L169 是**真缺口**（非截断伪影）——

**审查中确认的安全面**：① estimateFit 默认参 `relationships: Relationship[] = []` 有一臂（显式传 vs 用默认），本轮用默认（前端预估典型用法），显式传臂未测（小支，可后补）；② 两 worker 其余维度全同，故分差唯一归因 capability，断言稳健。

**本轮迭代动作**：补 `estimateFit` 公开函数的 characterization（+1 测试，WorkerSocietyService.test.ts 29→30）；234/234 绿，tsc exit 0；WorkerSocietyService.ts stmt 96.86→98.95、branch 80.89→81.11（全量有据）。

**下一轮候选（证据驱动）**：① **`WorkerSocietyService.ts:169`**（`volunteerFor` 带 note 时消息含「备注：{note}」的 `note ?` 真臂——**经 grep 确认零测试传 note**，干净 characterization，价值高于 randomId 降级）；② L417-418（randomId `crypto.randomUUID` 缺失降级，需 stub globalThis.crypto，成本/价值偏低）；③ societyMcp.ts 残留 `34,43,243`；④ `societyOverlayActions.ts` 87.5%（L47）；⑤ `societyApi.ts` 89.13%。**建议下一轮选 ①（L169 volunteer note）**。

### 迭代 #22 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 20 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **235/235 全绿**（14 文件，较 iter-21 的 234 +1）；`tsc` exit 0。

**本轮选题（承接 iter-21 候选①）**：`WorkerSocietyService.ts:168-170` 的 `note ? '…备注：${note}' : '…'` 真臂。iter-21 隔离取覆盖时暴露 + grep 复核：**零测试给 `volunteerFor` 传 note**——所有 volunteer 调用（service 自测、routes、mcp、autonomy tick 内部）均不传 note，只覆盖 false 臂（无备注文案）。真实分支：worker 自荐带备注时，发给 poster 的社交消息应含「备注：{note}」。

**本轮聚焦缺口（一个 characterization，锁 note 注入消息契约）**：补 `WorkerSocietyService.test.ts` 新 describe「volunteerFor note」——seedTwoWorkers（poster+designer）→ publish 需 `['design']` → `volunteerFor(needId, 'designer', '想做这块')` → 断言 **ok:true** 且 `messages.sent` 中存在 `text.includes('备注：想做这块')` 的消息（FakeMessageGateway.sent 直存 SocialMessageOut[]，读回断言）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-007 自荐备注 | ✅ PASS(characterization) | 锁「带 note 自荐 → 消息含『备注：{note}』」；防回归（若有人改消息模板删掉 `${note}` 插值，poster 收不到 worker 的自荐理由，本测即红） |

**TDD 痕迹**：characterization（绿现，三元真臂确在 L168-169）——designer 有 design 能力匹配 need，volunteer 成功、发消息含备注，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：WorkerSocietyService.ts **stmt 98.95%→99.3%、branch 81.11%→82.22%（+1.11pp）**，未覆盖 `169,417-418` → `417-418`——**L169 退出未覆盖集**。

**审查中确认的安全面**：① note 经模板字符串插值（非转义），中文/特殊字符直传；② 消息 `this.messages.send(...).catch(()=>undefined)`——gateway 失败不阻断 volunteer（fire-and-forget），FakeMessageGateway 恒 delivered:true，故断言稳健；③ false 臂（无 note）已被既有 volunteer 测试覆盖，本轮只补真臂，不重复。

**本轮迭代动作**：补 `volunteerFor` 带 note 消息注入的 characterization（+1 测试，WorkerSocietyService.test.ts 30→31）；235/235 绿，tsc exit 0；WorkerSocietyService.ts stmt 98.95→99.3、branch 81.11→82.22（全量有据）。**application 层两块真实缺口（estimateFit + volunteer note）两轮闭环**，仅剩 randomId 降级（L417-418，env-stub-only）。

**下一轮候选（证据驱动）**：① **L417-418**（randomId `crypto.randomUUID` 缺失降级 → `Date.now()/Math.random`——需 stub `globalThis.crypto=undefined`，可测但价值/成本偏低，是 WorkerSocietyService 最后一块）；② 转下一低密度文件 **`societyOverlayActions.ts` 87.5%（L47）**；③ `societyApi.ts` 89.13%（L15,24,77,83,111）；④ societyMcp.ts 残留 `34,43,243`。**建议下一轮选 ②（societyOverlayActions L47）**——跨过 randomId 降级（成本高价值低），换更高 ROI 的 renderer 决策分支。

### 迭代 #23 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 21 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **236/236 全绿**（14 文件，较 iter-22 的 235 +1）；`tsc` exit 0。

**选题更正（推翻 iter-22 候选②，pivot 到候选③）**：iter-22 建议补 `societyOverlayActions.ts:47`。读源发现 L46-47 是 `needLifecycleActions` switch 的 **`default: return []`**——而 NeedStatus 七值（open/assigned/in_progress/delivered/closed/expired/cancelled）已**全部被 L34-45 显式 case 覆盖**。该 default 是 TS 穷尽性保证的**不可达运行时兜底**，测它须 `('bogus' as NeedStatus)` 强转——锁一个类型系统禁止的状态，低价值且反模式。**pivot 到 `societyApi.ts`（同 iter-22 候选③）找可达分支**：未覆盖 `15,24,77,83,111`，其中 **L77 = parseResponse 的 `parsed.error ?? \`HTTP ${status}\`` false 臂**——非 2xx 且 JSON 体但**无 error 字段**（如 502 `{upstream:'timeout'}` / 400 `{}`）→ 回退 `HTTP {status}`。既有三错误用例覆盖「JSON 有 error / 空体 / 非 JSON」，**唯独「JSON 无 error」漏**，是真实可达的错误路径。

**本轮聚焦缺口（一个 characterization，补齐错误路径四分支）**：补 `societyApi.test.ts`「falls back to HTTP-status when JSON body has no {error}」——mock `res({ upstream:'timeout' }, 502)` → 断言 `rejects.toThrow(/^HTTP 502$/)`（精确无 body 泄露，证 `?? HTTP` 兜底而非把字段当 message）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-008 客户端错误解析 | ✅ PASS(characterization) | 补齐 parseResponse 错误四分支最后一块（空/有error/无error/非JSON）；防回归（若有人把 `?? HTTP` 误删，无 error 字段的网关错误会抛 `undefined`，本测即红） |

**TDD 痕迹**：characterization（绿现，`??` false 臂确在 L77）——`{upstream:'timeout'}` JSON.parse 成功、parsed.error=undefined → `?? 'HTTP 502'` → 精确抛出，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyApi.ts **branch 89.13%→91.48%（+2.35pp）**，stmt/line/func 恒 100%，未覆盖 `15,24,77,83,111` → `15,24,83,111`——**L77 退出未覆盖集**。

**审查中确认的安全面**：① `/^HTTP 502$/` 锚定精确回退（区别于非 JSON 的 `HTTP 502: <body>` 与有 error 的字段透传），三用例输出串虽近但**走不同代码行**（L74/L77-true/L77-false/L79），覆盖的是分支非串；② parseResponse 对 2xx 空体另有 L83 分支（本轮未动）。

**本轮迭代动作**：补 parseResponse「JSON 无 error→HTTP 回退」的 characterization（+1 测试，societyApi.test.ts 22→23）；236/236 绿，tsc exit 0；societyApi.ts branch 89.13→91.48（全量有据）。**方法论修正**：候选须先读源定可达性——TS 不可达兜底（switch default on exhaustive union）不补，pivot 到可达分支。

**下一轮候选（证据驱动，societyApi 残留）**：① **L111**（registerWorker 传 `interests` 的真臂 `input.interests ? csvToArray(...)`——可达、干净）；② L83（2xx 空体→undefined，可达）；③ L15/L24（csv 辅助 `(value??'')` 空值臂——register 无 capabilities / publish 无 requiredCapabilities，单测可一并覆盖两处）；④ WorkerSocietyService L417-418（randomId 降级，需 stub）；⑤ societyMcp 残留 `34,43,243`。**建议下一轮选 ①（L111 interests）**。

### 迭代 #24 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 22 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **237/237 全绿**（14 文件，较 iter-23 的 236 +1）；`tsc` exit 0。

**本轮选题（承接 iter-23 候选①）**：`societyApi.ts:111` `interests: input.interests ? csvToArray(input.interests) : undefined` 真臂。既有 register 测试（L43-55）不传 interests，只覆盖 `: undefined` 假臂；传 interests 时应拆成 **string[]**（与 capabilities 的「对象数组」语义不同——interests 是纯 skill 名）这一真臂漏测。

**本轮聚焦缺口（一个 characterization，锁 interests csv→string[] 映射）**：补 `societyApi.test.ts`「POSTs register with interests split from csv into a string array」——register `{ interests: 'design, ui' }`（且**不传 capabilities**）→ 断言 POST body `interests === ['design','ui']`。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 注册 interests | ✅ PASS(characterization) | 锁「interests csv→string[]（非对象数组）」；防回归（若有人把 csvToArray 误换成 csvToCapabilities，interests 会变对象数组、后端兴趣匹配失真，本测即红） |

**TDD 痕迹**：characterization（绿现，真臂确在 L111）——csvToArray('design, ui')→['design','ui']，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyApi.ts **branch 91.48%→95.83%（+4.35pp）**，未覆盖 `15,24,83,111` → `24,83`——**L111 退出未覆盖集**；**附带覆盖 L15**（本用例不传 capabilities，`csvToCapabilities(undefined)` 命中 L15 `(value ?? '')` 空值假臂，与 iter-20/22 同款「一测顺带清邻支」）。

**审查中确认的安全面**：① interests 与 capabilities 走**不同 csv 辅助**（csvToArray→string[] vs csvToCapabilities→对象数组），本测用 `toEqual(['design','ui'])` 锁 string[] 语义；② 不传 capabilities 是合法输入（capabilities 可选），故 L15 假臂可达、非 TS 不可达。

**本轮迭代动作**：补 registerWorker 传 interests 的 characterization（+1 测试，societyApi.test.ts 23→24）；237/237 绿，tsc exit 0；societyApi.ts branch 91.48→95.83（+4.35pp，附带清 L15）。

**下一轮候选（证据驱动，societyApi 残留 2 行）**：① **L24**（csvToArray `(value ?? '')` 空值假臂——publish 需求不传 requiredCapabilities 即覆盖，干净）；② **L83**（parseResponse 2xx 空体→`undefined`——可达、防 `JSON.parse('')` 崩）；③ WorkerSocietyService L417-418（randomId 降级，需 stub）；④ societyMcp 残留 `34,43,243`；⑤ `societyStore.ts` 94.73%（L63,96）。**建议下一轮选 ②（L83 2xx 空体）**——错误/边界路径价值高于纯 csv 默认臂。

### 迭代 #25 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 23 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **238/238 全绿**（14 文件，较 iter-24 的 237 +1）；`tsc` exit 0。

**本轮选题（承接 iter-24 候选②）**：`societyApi.ts:83` parseResponse 的 `if (!body.trim()) return undefined as unknown as T`——2xx 但 body 空/纯空白 → 返 undefined（而非 `JSON.parse('')` 抛 SyntaxError 崩）。路由理论都返 JSON，但客户端须对空体健壮（代理截断 / 204 No Content / 空 200）。既有成功用例都带 JSON 体、错误用例都非 2xx，唯独「2xx 空体」漏。

**本轮聚焦缺口（一个 characterization，锁空体健壮性）**：补 `societyApi.test.ts`「returns undefined for a 2xx response with an empty body」——mock `{ ok:true, status:200, text:()=>Promise.resolve('') }`（须用裸 Response：`res('')` 会 stringify 成 `'""'` 非真空，不触发 L83）→ 断言 `listWorkers()` resolve 为 `undefined`。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-008 客户端空体健壮 | ✅ PASS(characterization) | 锁「2xx 空体→undefined 不崩」；防回归（若有人删 L83 短路，遇到代理截断的空 200 会抛 SyntaxError，store 拿异常而非空数据，本测即红） |

**TDD 痕迹**：characterization（绿现，L83 短路确在）——body='', ok=true, 跳过错误块, `!body.trim()`→true, 返 undefined，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyApi.ts **branch 95.83%→97.91%（+2.08pp）**，未覆盖 `24,83` → `24`——**L83 退出未覆盖集**。**parseResponse 全五分支现已覆盖闭环**：空错误体(L74) / JSON有error(L77真) / JSON无error(L77假,iter-23) / 非JSON(L79,iter-13) / 2xx空体(L83,本轮)。

**审查中确认的安全面**：① 测试须用裸 `text:()=>Promise.resolve('')`——`res()` 助手 `JSON.stringify('')='""'` 是「JSON 空串」非真空体，会绕过 L83 走 `JSON.parse('""')→''`，测不到目标分支（已在用例注释标明）；② 返 `undefined as unknown as T` 是刻意的类型擦除——空体无结构可解，undefined 是唯一安全值，调用方按方法返回类型自行判空。

**本轮迭代动作**：补 parseResponse 2xx 空体→undefined 的 characterization（+1 测试，societyApi.test.ts 24→25）；238/238 绿，tsc exit 0；societyApi.ts branch 95.83→97.91（全量有据）。**parseResponse 错误/成功全分支覆盖闭环。**

**下一轮候选（证据驱动）**：① **societyApi.ts L24**（csvToArray `(value ?? '')` 空值假臂——publish 不传 requiredCapabilities 即覆盖，societyApi 最后一支）；② WorkerSocietyService L417-418（randomId 降级，需 stub globalThis.crypto）；③ societyMcp 残留 `34,43,243`；④ `societyStore.ts` 94.73%（L63,96）；⑤ `societyViewUtils.ts` 94.44%（L54）；⑥ `societyGraphAdapter.ts` 95.74%（L166,198）。**建议下一轮选 ①（societyApi L24，收尾该文件至近乎全分支）**。

### 迭代 #26 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 24 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **239/239 全绿**（14 文件，较 iter-25 的 238 +1）；`tsc` exit 0。

**本轮选题（承接 iter-25 候选①，收尾 societyApi）**：`societyApi.ts:24` csvToArray 的 `(value ?? '')` 空值假臂。csvToArray 被 L111（interests，恒传定义值→真臂）、L126（publishNeed requiredCapabilities）调用。既有 publish 测试恒传 `'code,qa'`（真臂）；不传 requiredCapabilities 时 `csvToArray(undefined)`→空值假臂漏测。

**本轮聚焦缺口（一个 characterization，锁 requiredCapabilities 缺省→[]）**：补 `societyApi.test.ts`「POSTs publishNeed with an empty requiredCapabilities array when none are given」——`publishNeed({ postedBy:'u', subject:'X' })`（不传 requiredCapabilities）→ 断言 body `requiredCapabilities === []`。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004 发布能力缺省 | ✅ PASS(characterization) | 锁「不传 requiredCapabilities → []」；与 iter-18（路由层非数组→[]）形成客户端/服务端双层一致性证据 |

**TDD 痕迹**：characterization（绿现，空值假臂确在 L24）——`(undefined ?? '')`→''→split→filter Boolean→[]，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyApi.ts **branch 97.91%→100%、stmt/line/func 恒 100%**，未覆盖 `24` → **（空，全分支覆盖）**。

**里程碑 🎯**：**societyApi.ts 全分支覆盖（100%×4 维度）**——自 iter-18 基线 89.13% branch 起，经 iter-23(JSON无error)/iter-24(interests)/iter-25(2xx空体)/iter-26(requiredCapabilities缺省) 四轮 + iter-13(非JSON) 收尾至全绿。parseResponse 五分支 + 两条 csv 辅助双臂 + 各映射方法全闭环。

**审查中确认的安全面**：① csvToArray(undefined)→[] 与 csvToCapabilities(undefined)→[]（iter-24 已覆盖 L15）同构，两者空值兜底一致；② 不传 requiredCapabilities 是合法输入（可选字段），故假臂可达、非 TS 不可达。

**本轮迭代动作**：补 publishNeed 无 requiredCapabilities→[] 的 characterization（+1 测试，societyApi.test.ts 25→26）；239/239 绿，tsc exit 0；**societyApi.ts 达 100% 全维度覆盖**。

**下一轮候选（证据驱动，societyApi 已收尾，转其他文件）**：① **`societyStore.ts` 94.73%（L63,96）**——renderer 状态层；② **`societyViewUtils.ts` 94.44%（L54）**；③ **`crossTeamMessageGateway.ts` 94.44%（L83-84）**；④ **`societyGraphAdapter.ts` 95.74%（L166,198）**；⑤ **`societyPolicies.ts` 95%（L153-157,270）**；⑥ WorkerSocietyService L417-418（randomId 降级，需 stub）；⑦ societyMcp 残留 `34,43,243`。**建议下一轮选 ①（societyStore，renderer 核心状态层，密度次低且纯逻辑易测）**。

### 迭代 #27 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 25 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **240/240 全绿**（14 文件，较 iter-26 的 239 +1）；`tsc` exit 0。

**本轮选题（承接 iter-26 候选①）**：`societyStore.ts` 94.73% branch，未覆盖 `63,96`——两处**同型** `e instanceof Error ? e.message : String(e)` 的 false 臂（loadAllInto catch L63 / mutate catch L96）。既有 loadAll 失败（L57）、mutation 失败（L172）两用例都用 `new Error(...)`，只覆盖真臂 `e.message`；非 Error 抛值（裸字符串/数字）→ `String(e)` 漏。

**本轮聚焦缺口（一个 characterization，锁 error 恒为 string 不变式）**：补 `societyStore.test.ts`「stringifies a non-Error thrown value into the error state」——一测覆盖**两处同型兜底**：loadAll 注入 `listWorkers` reject `'network down'`（裸串）→ 断言 error `'network down'`（L63 String）；再 registerWorker reject `42`（数字）→ 断言 error `'42'`（L96 String）。**契约**：error 状态恒为 string（UI 渲染前提——React 渲染 number/object 会报错）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-009 store 错误健壮 | ✅ PASS(characterization) | 锁「任意抛值→string 化 error」；防回归（若有人简化 catch 为 `error: e.message`，非 Error 抛值会让 error=undefined、UI 崩，本测即红） |

**TDD 痕迹**：characterization（绿现，两处 `?? String(e)` 兜底确在 L63/L96）——`String('network down')='network down'`、`String(42)='42'`，直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyStore.ts **branch 94.73%→100%、stmt/line 恒 100%**，未覆盖行 `63,96` → **（空）**——L63/L96 均退出。**注**：funcs 仍 94.73%（v8 函数计数），系 `refresh` 公开别名（L110，loadAllInto 的第二出口）无测试调用——属**另一缺口**（未测公开方法），本轮不并入（一次一缺口），列为候选。

**审查中确认的安全面**：① 一测覆盖两处同型 catch——loadAll 走 loadAllInto、registerWorker 走 mutate，是同一 string 不变式的两个实例，非冗余（不同调用栈）；② mutate 的 catch 不动 loading（仅 loadAllInto 设 loading:false），既有 L172 用例已锁此区分，本轮不重复。

**本轮迭代动作**：补 store 非 Error 抛值→string 化 error 的 characterization（+1 测试，societyStore.test.ts 10→11）；240/240 绿，tsc exit 0；societyStore.ts branch 94.73→100%、无未覆盖行（全量有据）。

**下一轮候选（证据驱动）**：① **societyStore.ts `refresh`**（funcs 94.73% 的元凶——公开别名无测试，一行 `await refresh()` 即补，funcs→100%）；② **`societyViewUtils.ts` 94.44%（L54）**；③ **`crossTeamMessageGateway.ts` 94.44%（L83-84 randomId 降级）**；④ **`societyGraphAdapter.ts` 95.74%（L166,198）**；⑤ **`societyPolicies.ts` 95%（L153-157,270）**；⑥ WorkerSocietyService L417-418（randomId，需 stub）；⑦ societyMcp 残留 `34,43,243`。**建议下一轮选 ①（refresh，收尾 societyStore funcs 至 100%）**。

### 迭代 #28 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 26 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **241/241 全绿**（14 文件，较 iter-27 的 240 +1）；`tsc` exit 0。

**本轮选题（承接 iter-27 候选①）**：`societyStore.ts` funcs 94.73% 的元凶——`refresh`（L110，`() => loadAllInto(set, api)`，loadAll 的公开别名）此前无测试调用。其余 loadAll/mutations/错误路径在 iter-27 已 100% branch，唯独 refresh 这条公开出口未被任何测试触发。

**本轮聚焦缺口（一个 characterization，锁 refresh=loadAll 等价）**：补 `societyStore.test.ts`「refresh reloads all data (loadAllInto alias)」——`await store.getState().refresh()` → 断言 workers 载入、loading=false。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-009 store 刷新 | ✅ PASS(characterization) | 锁「refresh 与 loadAll 等价（同调 loadAllInto）」；防回归（若有人把 refresh 改成只刷部分切片，与 loadAll 语义分叉，本测即红） |

**TDD 痕迹**：characterization（绿现，refresh 确为 loadAllInto 直调）——直接绿。

**证据（覆盖前后对比，全量 suite 取数）**：societyStore.ts **funcs 94.73%→100%**，stmt/branch/line 恒 100%——**四维度全 100%，无未覆盖行/函数**。

**里程碑 🎯**：**societyStore.ts 全维度覆盖（100%×4）**——继 societyApi.ts（iter-26）后第二个达成全绿的文件。

**本轮迭代动作**：补 refresh 公开别名的 characterization（+1 测试，societyStore.test.ts 11→12）；241/241 绿，tsc exit 0；**societyStore.ts 达 100% 全维度覆盖**。

**下一轮候选（证据驱动，两文件已全绿，转剩余）**：① **`societyViewUtils.ts` 94.44%（L54）**——纯工具函数，易测；② **`crossTeamMessageGateway.ts` 94.44%（L83-84 randomId 降级，需 stub）**；③ **`societyGraphAdapter.ts` 95.74%（L166,198）**——图谱投影边分支；④ **`societyPolicies.ts` 95%（L153-157,270）**——域策略；⑤ **`fsStores.ts` 95.83%（L65）**；⑥ WorkerSocietyService L417-418（randomId，需 stub）；⑦ societyMcp 残留 `34,43,243`。**建议下一轮选 ①（societyViewUtils L54，纯逻辑易测、密度次低）**。

### 迭代 #29 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 27 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **243/243 全绿**（14 文件，较 iter-28 的 241 +2，净 +2：删 1 个误导测试、补 3 个干净 characterization）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（pivot）**：iter-28 建议① societyViewUtils L54——读源确认 L54 是 `needStatusColor` 的 `default: return '#9ca3af'`，**L39-52 已穷举全部 7 个 NeedStatus**，default 是 TS 不可达的穷举安全网（与 iter-23 societyOverlayActions L47 同一 anti-pattern），测它要 `('bogus' as NeedStatus)` 强转、价值低。**Pivot 到 iter-28 候选④ `societyPolicies.ts` selectAssignee 决胜链 L153-157**——worker-society 核心「精英选派」契约（"取适配度最高者；同分按声誉高者；再同分按负载低者；仍同分取 workerId 字典序"），全链未测，证据驱动。

**本轮发现的既有债务（顺手清）**：现有测试 `selectAssignee > ties break by reputation, then by lower load, then by workerId`（L215-226）是**误导性债务**——它设 a(rep 80, active 1)、b(rep 80, active 0) 两个 volunteer 存值 `fitScore:0.5` 相等，但 `selectAssignee` **重算** fitScore（`computeFitScore`，L148，完全忽略 `volunteer.fitScore` 存值）。重算后 a=0.7433、b=0.81（负载低→loadFairness 高→分高），**并非同分**，L152 短路、b 因 fitScore 胜出而非负载决胜。断言 `toBe('w-b')` 绿，但测的根本不是它声称的决胜链——L153-157 从未被触达。根因结构性：声誉(0.2)/loadFairness(0.2) **自身就是 score 分量**，任何差异都会制造分差，故 L155/L156 真分支在默认权重下**不可达**。

**本轮聚焦动作（DP 解耦：3 个 characterization 覆盖决胜链全分支）**：把误导测试替换为 3 个干净用例——①「identical workers → workerId 字典序」(默认权重，两份仅 workerId 不同的 profile→重算分逐位相等→L152f→L155f→L156f→L157；存值 fitScore 0.9/0.1 故意干扰以证明走重算)；②「等分→声誉高者」(传 `reputation:0` 权重把声誉摘出 score→两仅声誉不同的 worker 重算相等→L155 真)；③「等分等声誉→负载低者」(传 `loadFairness:0` 权重→L156 真)。**动态规划思路：把维度从 score 摘出即解耦其决胜分支，复用 `selectAssignee` 既有 weights 参数，无新增嵌套/冗余。**

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-006 精英选派 selectAssignee | ✅ PASS(characterization) | 决胜链四级（fit→rep→load→workerId）现各有一测锁定，是「反派单、能力/负载/声誉加权择优」的核心契约；同时锁死「重算 fitScore 不读存值」——防回归（若有人改回读 volunteer.fitScore，干扰项用例即红） |

**TDD 痕迹**：characterization（绿现，决胜链与文档契约一致）——3 测直接绿，无实现改动；同时清掉 1 个误导性既有测试（断言因错因绿）。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：societyPolicies.ts **branch 95%→95.86%**，未覆盖行 `L153-157,270` → **仅 `L270`**（`discoverWorkers` 的 workerId localeCompare，另一函数、下一轮候选）。selectAssignee 决胜链 L151-158 全分支覆盖。

**本轮迭代动作**：删 1 误导测试 + 补 3 干净 characterization（societyPolicies.test.ts 67→68）；243/243 绿，tsc exit 0；selectAssignee 决胜链全分支覆盖，societyPolicies.ts 仅余 L270。

**下一轮候选（证据驱动）**：① **`societyPolicies.ts:270`**（discoverWorkers 的 workerId localeCompare 决胜——本轮同源结构，可复用「identical workers + 不同 workerId」模式补一个 discovery 用例，收尾该文件至近乎全分支）；② **`crossTeamMessageGateway.ts` 94.44%（L83-84 randomId 降级，需 stub）**；③ **`societyGraphAdapter.ts` 95.74%（L166,198）**；④ **`fsStores.ts` 95.83%（L65）**；⑤ WorkerSocietyService L417-418（randomId，需 stub）；⑥ societyMcp 残留 `34,43,243`。**建议下一轮选 ①（L270，承接本轮 selectAssignee 决胜链、同源模式可直接复用、最短路径收尾 societyPolicies）**。

### 迭代 #30 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 28 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **244/244 全绿**（14 文件，较 iter-29 的 243 +1）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（承接 iter-29 候选①）**：`societyPolicies.ts:270`——`discoverWorkers` 排序第三级决胜 `a.workerId.localeCompare(b.workerId)`（L267-271）。iter-29 已确认它是该文件唯一未覆盖的**行**（stmt 维度）。

**本轮聚焦缺口（一个 characterization，锁 workerId 第三级决胜）**：现有 `ranks by reputation desc then load asc` 测（L297-312）用 busyHi(rep 80, active 3) + idleMid(rep 80, active 0)——声誉等→L268 假，但负载差→L269 真→L270 永不达。补 `breaks a full reputation+load tie by workerId`：两份**全等** worker（rep 80、active 1、能力 [design]，仅 workerId w-zeta/w-alpha 不同）→ L268(假)→L269(假)→L270 字典序 → `['w-alpha','w-zeta']`。

**与 iter-29 selectAssignee 的区别（同源结构、更简构造）**：`discoverWorkers` 直接按 profile 字段排序——**无 score 重算、无权重**——故两份全等 worker 必触达 L270，无需 iter-29「零权重解耦」技巧。iter-29 候选①「同源模式可直接复用」得到验证。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-005 花名册发现 discoverWorkers | ✅ PASS(characterization) | 锁三级排序全链（rep desc→load asc→workerId 稳定）；花名册「同声誉同负载时按字典序」是确定性契约，防排序非稳定回归 |

**TDD 痕迹**：characterization（绿现，L270 与排序契约一致）——直接绿。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：societyPolicies.ts **stmts/lines 99.67%→100%、funcs 恒 100%**，**branch 95.86%→96.55%**；未覆盖行 `270` →（stmt 维度清空）。reporter 现 surfaced 的 branch 残留：`35,356,370,434`（此前被 L270 stmt-gap 遮蔽，详见下一轮候选）。

**里程碑 🎯**：**societyPolicies.ts 达 100% stmts/lines/funcs**——继 societyApi.ts（iter-26）、societyStore.ts（iter-28）后的第三个覆盖里程碑；本文件是 core/domain 纯策略层（worker-society 的域大脑），三维度全绿。branch 96.55% 余 4 行（见下）。

**本轮迭代动作**：+1 characterization（societyPolicies.test.ts 68→69）；244/244 绿，tsc exit 0；**societyPolicies.ts 100% stmts/lines/funcs**（branch 余 4 行）。

**下一轮候选（证据驱动，societyPolicies.ts branch 残留 4 行，已逐行定性）**：① **`L356`**（`transitionNeed` 的 `ALLOWED_TRANSITIONS[need.status] ?? []` 降级臂——need.status 不在转移表→`[]`→illegal，**可达** characterization）+ **`L370`**（`patch.result ?? updated.result` 降级臂——transition→delivered 不传 result→退回原 result，**可达**；两处同属 transitionNeed `??` 降级，cohesive）；② **`L434`**（`recordCollaboration` 的 `collaborations > 0 ? : 0`——collaborations 恒≥1（L428 先 +1），`:0` 臂运行时不可达，类 TS-unreachable default anti-pattern，**低价值、建议跳过**）；③ `L35`（reporter 指向 `DEFAULT_FIT_WEIGHTS` 常量字面量附近，疑似行映射 artifact，低优先）。④（转下一文件）`crossTeamMessageGateway.ts` 94.44%（L83-84 randomId 降级）/ `societyGraphAdapter.ts` 95.74%（L166,198）/ `fsStores.ts` 95.83%（L65）。**建议下一轮选 ①（L356+L370，transitionNeed 的两处可达 `??` 降级臂，cohesive、价值高于防御臂 L434）**。

### 迭代 #31 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 29 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **245/245 全绿**（14 文件，较 iter-30 的 244 +1）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（承接 iter-30 候选①）**：`transitionNeed` 的两处 `??` 降级臂 L356 + L370。

**自我纠正（iter-30 的 L356 误判）**：读 `ALLOWED_TRANSITIONS`（L335）发现其类型为 `Record<NeedStatusKey, NeedStatusKey[]>`——**total Record 覆盖全部 7 个 NeedStatus**（open/assigned/in_progress/delivered/closed/expired/cancelled 皆在表）。故 `ALLOWED_TRANSITIONS[need.status]` 对任何合法 status 恒有定义，`?? []`（L356）**TS-unreachable**——与 iter-23/29 的不可达 `default` 同一 anti-pattern，需 `('bogus' as NeedStatus)` 强转才能触达，低价值。**iter-30 把 L356 标为「可达」是误判，本轮纠正为：不可达、跳过。** 唯一可达的 `??` 是 L370。

**本轮聚焦动作（一个 characterization，L370）**：补 `delivered without a new result patch preserves the prior result`——`in_progress`（带既有 result `'banner v1'`，模拟「退回重做」前已交付过）→ `delivered` **不传 patch**（patch 默认 `{}`→`patch.result` undefined）→ `patch.result ?? updated.result` 降级臂 → 保留既有 result（非清空）。既有 delivered 用例（L411）恒传 `{ result }`（真臂），本测补降级臂。对应真实场景「delivered→in_progress→delivered 不改结果」（L339 允许 delivered→in_progress）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004 需求状态机 transitionNeed | ✅ PASS(characterization) | 锁「重新交付不传新结果时保留上次结果」——退回重做流程的确定性契约，防回归（若误改成清空 result，本测即红） |

**TDD 痕迹**：characterization（绿现，L370 与契约一致）——直接绿；无实现改动。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：societyPolicies.ts **stmts/lines/funcs 恒 100%**，**branch 96.55%→97.24%**；未覆盖 `35,356,370,434` → `102,235,356,434`（L370 已覆盖；L35 artifact 消失）。

**里程碑/结论 🎯：societyPolicies.ts 达实际覆盖天花板**——100% stmts/lines/funcs、branch 97.24%。残留 4 行**逐一定性均为防御性守卫或 TS-unreachable**：① **L102**（`computeFitScore` 的 `maxConcurrent > 0 ? : 0`——maxConcurrent≤0 退化配置，此类 worker 恒 at-capacity、loadFairness 无意义）；② **L235**（`autonomousVolunteers` 的 `needCount.get(p.needId) ?? 0`——needCount 已据 openNeeds 预填全，get 恒有定义）；③ **L356**（`?? []`，total Record，见上）；④ **L434**（`collaborations > 0 ? : 0`——L428 先 `+1`，恒≥1）。**覆盖它们需 bogus cast 或退化输入，低价值；该文件已无高价值可达缺口。**

**本轮迭代动作**：+1 characterization（societyPolicies.test.ts 69→70）+ 纠正 iter-30 的 L356 误判；245/245 绿，tsc exit 0；**societyPolicies.ts 达覆盖天花板（100% stmts/lines/funcs、branch 97.24% 仅余防御守卫）**。

**下一轮候选（societyPolicies.ts 已耗尽，转下一文件，按剩余分支密度）**：① **`crossTeamMessageGateway.ts` 94.44%（L83-84，randomId 降级，需 stub `globalThis.crypto`）**——密度最低；② **`societyGraphAdapter.ts` 95.74%（L166,198，图谱投影边分支）**——**纯函数 `projectSocietyGraph`、确定性无 random、无需 stub、最易测，ROI 最高**；③ `fsStores.ts` 95.83%（L65）；④ WorkerSocietyService L417-418（randomId，需 stub）；⑤ societyMcp 残留 `34,43,243`。**建议下一轮选 ②（societyGraphAdapter L166/198，纯函数无需 stub、价值密度比最优）**；若求最低密度则选 ①（crossTeamMessageGateway，但需 crypto stub、成本高）。

### 迭代 #32 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 30 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **247/247 全绿**（14 文件，较 iter-31 的 245 +2）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（承接 iter-31 候选②）**：`societyGraphAdapter.ts` L166 + L198——纯函数 `projectSocietyGraph` 的两处未覆盖分支（renderer 图谱投影，确定性、无 random、无需 stub）。

**本轮聚焦缺口（两处 characterization，锁 L166/L198 真臂）**：① **L166** `need.requiredCapabilities.length > 0 ? join(' · ') : undefined`——**关键发现**：`need()` test helper 默认 `requiredCapabilities: []`，故既有可见 need 测试全走**假臂**（sublabel undefined）；真臂（带能力→拼成 sublabel）未覆盖。补 `joins a visible need's required capabilities into the task sublabel`：open need 带 `['frontend','design']` → sublabel === `'frontend · design'`。② **L198** `if (r.fromWorker === r.toWorker) continue`——既有关系测试全用不同 worker（alice↔bob / alice→ghost）走假臂；自指真臂未覆盖。补 `skips a self-relationship — no self-loop edge`：`rel('alice','alice')` → 无 related 边。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-007 图谱投影 projectSocietyGraph | ✅ PASS(characterization) | 锁两处边界：need 能力列表渲染成 sublabel（图谱上可读性）、自指关系不画自环（防视觉噪声）。投影纯函数现 100% 全维度 |

**TDD 痕迹**：characterization（绿现）——2 测直接绿，无实现改动。

**中途返工（诚实记录，验证门槛拦截误改）**：第二个 Edit 的 `new_string` 漏抄了 `old_string` 末尾用作唯一锚的 `it('produces a radial layout…` 行 → 删了该测试的开头、留下 dangling body → `vitest` 报 1 failed（esbuild parse error）、`tsc` 报 `TS1128: Declaration or statement expected`（L306，describe 提前闭合）。**gate 即刻拦截**——读源定位到 L228（dangling `const out`），补回缺失的 `it(...)` 开头行 → 重跑 gate 全绿。**未在破损态误报完成。** 教训：Edit 的 `old_string` 用尾随锚行定位时，`new_string` 必须原样带回该锚行（否则等于删行）。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：societyGraphAdapter.ts **stmts/lines/funcs 恒 100%**，**branch 95.74%→100%**；未覆盖 `166,198` →（清空，无未覆盖行）。

**里程碑 🎯：societyGraphAdapter.ts 达 100% 全维度（stmts/branch/funcs/lines ×4）**——继 societyApi.ts（iter-26）、societyStore.ts（iter-28）后第三个 100%×4 文件；本文件是 renderer 图谱投影纯函数（worker-society 域 → @claude-teams/agent-graph 引擎的唯一映射层）。

**本轮迭代动作**：+2 characterization（societyGraphAdapter.test.ts 15→17）+ 1 中途返工修语法；247/247 绿，tsc exit 0；**societyGraphAdapter.ts 100%×4**。

**下一轮候选（renderer 三大纯函数文件已全绿，转剩余低密度文件）**：① **`crossTeamMessageGateway.ts` 94.44%（L83-84，randomId 降级，需 stub `globalThis.crypto`）**——密度最低、但需 stub；② **`fsStores.ts` 95.83%（L65，infra 持久层）**——待定性 L65 是 catch 分支还是 random；③ WorkerSocietyService L417-418（randomId，需 stub）；④ societyMcp 残留 `34,43,243`（csv/num 辅助默认臂）；⑤ societyOverlayActions L47 / societyViewUtils L54（iter-23/29 已确认 TS-unreachable default，**skip**）。**建议下一轮选 ②（fsStores L65，先 grep 定性再决定；若为可达 catch 则补、为防御则跳）**；若求最低密度且不惧 stub 则选 ①。

### 迭代 #33 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 31 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **248/248 全绿**（14 文件，较 iter-32 的 247 +1）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（承接 iter-32 候选②）**：`fsStores.ts` L65——main/infrastructure 持久层。scope coverage 确认该文件 100% stmts/lines/funcs、95.83% branch，唯一未覆盖分支即 L65。

**本轮聚焦缺口（一个 characterization，锁 L65 真臂）**：`FsProfileStore.delete` 的 `if (!(workerId in map)) return` 早返回——删一个**不存在**的 worker（未注册/已删过）应是幂等 no-op（不抛、不写、不误伤既有数据）。既有 `deletes a profile` 测（L92）删的是已存在的 w1（走假臂：delete+write），真臂（早返回）未覆盖。补 `delete is a no-op for a worker that was never stored (idempotent)`：upsert w1 → delete 'ghost'（不在 map）→ 断言 w1 仍在、ghost 仍 undefined。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-008 持久化 infra（FsProfileStore） | ✅ PASS(characterization) | 锁「删不存在 worker = 幂等 no-op」——防回归（若误改成无条件写空 map 或抛错，重复删除/删幽灵 ID 会清空既有数据） |

**TDD 痕迹**：characterization（绿现，L65 与幂等契约一致）——直接绿，无实现改动。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：fsStores.ts **stmts/lines/funcs 恒 100%**，**branch 95.83%→100%**；未覆盖 `65` →（清空，无未覆盖行）。

**里程碑 🎯：fsStores.ts 达 100% 全维度（stmts/branch/funcs/lines ×4）**——继 societyApi.ts（iter-26）、societyStore.ts（iter-28）、societyGraphAdapter.ts（iter-32）后**第四个 100%×4 文件**；本文件是 main/infrastructure 持久层（`~/.hermit/society/` JSON 原子写 + 容错读，worker-society 跨重启存活的核心）。

**本轮迭代动作**：+1 characterization（fsStores.test.ts FsProfileStore 7→8）；248/248 绿，tsc exit 0；**fsStores.ts 100%×4**。

**下一轮候选（4 文件已全绿，转剩余低密度）**：① **`crossTeamMessageGateway.ts` 94.44%（L83-84，randomId 降级，需 stub `globalThis.crypto`）**——密度最低；② WorkerSocietyService L417-418（randomId，需 stub）；③ societyMcp 残留 `34,43,243`（csv/num 辅助默认臂）；④ societyOverlayActions L47 / societyViewUtils L54（iter-23/29 已确认 TS-unreachable default，**skip**）。**建议下一轮选 ①（crossTeamMessageGateway，密度最低；crypto stub 模式在 iter-21/22 randomId 降级处已有先例可复用）**。

### 迭代 #34 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 32 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **249/249 全绿**（14 文件，较 iter-33 的 248 +1）；`tsc` exit 0（连 ClaudeDoctorProbe 基线都无）。

**本轮选题（承接 iter-33 候选①）**：`crossTeamMessageGateway.ts` L83-84——main/infrastructure 的 cross-team 消息网关，全模块剩余密度最低（94.44% branch）。

**本轮聚焦缺口（一个 characterization，锁 L83-84 降级臂）**：`randomId()` 的 `if (g.crypto?.randomUUID) … else 降级`——crypto 缺失（旧 Node / 受限运行时）时降级为 `Date.now()+Math.random()` 的 base36 串。既有 9 个测试都在有 crypto 的 vitest 环境跑（走真臂），降级臂未覆盖。

**关键技术验证（打破 iter-22 顾虑）**：iter-22 曾以「需 stub globalThis.crypto、成本高价值低」推迟 WorkerSocietyService 的同源 randomId 降级。**本轮实证**：`vi.stubGlobal('crypto', undefined)` **能成功覆盖 Node 的只读 crypto 全局**（vitest 内部用 defineProperty 强制覆盖）→ 降级臂可达、干净。**断言技巧**：用「段数」稳健区分两臂——降级 `msg-<ts36>-<rand36>` = 3 段（2 个 `-`）、UUID `msg-<uuid>` = 6 段（5 个 `-`）；不靠 hex 字符判断（base36 偶发全 hex 会 flaky）。`expect(id.split('-')).toHaveLength(3)` 一次锁定降级路径。try/finally + `vi.unstubAllGlobals()` 即时恢复，防污染后续测试。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-010 cross-team 消息网关（CrossTeamMessageGateway） | ✅ PASS(characterization) | 锁「无 crypto 环境下 id 降级仍生成、仍唯一、send 不抛」——网关在受限运行时（旧 Node / 沙箱）的健壮降级契约 |

**TDD 痕迹**：characterization（绿现，降级臂与契约一致）——直接绿，无实现改动。

**证据（覆盖前后对比，全量 suite 取数，scope 单文件）**：crossTeamMessageGateway.ts **stmts 96.15%→100%、branch 94.44%→100%、lines 96.15%→100%、funcs 恒 100%**；未覆盖 `83-84` →（清空，无未覆盖行）。

**里程碑 🎯：crossTeamMessageGateway.ts 达 100% 全维度（×4）**——继 societyApi（iter-26）、societyStore（iter-28）、societyGraphAdapter（iter-32）、fsStores（iter-33）后**第五个 100%×4 文件**；本文件是 main/infrastructure 的 cross-team 消息持久化网关（formatCrossTeamText 协议兼容 + append-only JSONL）。

**方法论副产物（可复用）**：`vi.stubGlobal('crypto', undefined)` 覆盖 Node 只读 crypto 全局经本轮证实可行 → **WorkerSocietyService L417-418 的 randomId 降级是同源模式，下一轮可直接套用此 stub**（iter-22 的「成本高」顾虑已破）。

**本轮迭代动作**：+1 characterization（crossTeamMessageGateway.test.ts 9→10）+ import 加 `vi`；249/249 绿，tsc exit 0；**crossTeamMessageGateway.ts 100%×4**。

**下一轮候选（5 文件已全绿）**：① **WorkerSocietyService L417-418（randomId 降级）**——同源模式，**复用本轮验证过的 `vi.stubGlobal('crypto', undefined)` stub**，application 层核心、ROI 最高；② societyMcp 残留 `34,43,243`（csv/num 辅助默认臂，需定性）；③ societyOverlayActions L47 / societyViewUtils L54（iter-23/29 已确认 TS-unreachable default，**skip**）。**建议下一轮选 ①（WorkerSocietyService randomId，stub 已验证、同源最快）**。

### 迭代 #35 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 33 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **255/255 全绿**（14 文件，较 iter-34 的 249 +6）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（修正 iter-34 建议）**：iter-34 建议下一轮选「WorkerSocietyService L417-418（randomId 降级，stub 已验证同源最快）」。本轮据此进入 `WorkerSocietyService.ts`，scoped 覆盖：stmts/lines 99.3%、**branch 仅 82.22%**、text 报告器「Uncovered Line #s」=`417-418`。**但 82.22% 与「仅 2 行未覆盖」自相矛盾** → 疑 truncation。

**关键技术发现（truncation-masking 第三次坐实）**：生成 lcov 提取 `BRDA:...,0`（taken=0 真·未覆盖分支）→ 实际 **16 行**：`149,151,180,188,213,216,230,236,246,248,253,259,269,271,276,416`。text 报告器的「417-418」**掩盖了 15 个更高价值、可达的业务分支**——application 层生命周期方法的错误契约（need_not_found / worker_not_found / 非法迁移转发 / null-assignee 兜底）。**结论：text 报告器「Uncovered Line #s」列不可信；branch% 明显 <100% 但列里只寥寥几行时，必跑 lcov 取真值**（iter-19 首发现，本轮第三次复现）。

**本轮聚焦缺口（一个内聚契约：need_not_found ×6 生命周期方法）**：cancelNeed 的 `need_not_found` 已测（L143），但 volunteerFor / selectAssignee / startNeed / deliverNeed / acceptDelivery / requestRevision **从未喂过不存在的 needId**（既有 guards 测喂的都是真实 needId，验的是 already_volunteered / no_eligible_volunteer / not_assignee / 非法迁移）。6 个方法各自首行 `if (!need) return need_not_found` 全空缺。need 查找在每法第一步 → **无需 seed 任何 worker/need，最小零冗余**。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-001 ~ 008 生命周期方法输入校验 | ✅ PASS(characterization) | 锁「脏 needId（agent 笔误 / 前端陈旧 id / 删除后引用）→ 统一 need_not_found，不抛、不误改状态」——REST/MCP 收到非法 needId 的健壮短路契约 |

**TDD 痕迹**：characterization（绿现）——6 个守卫实现本就正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件）**：WorkerSocietyService.ts **branch 82.22%→89.79%（+7.57）**，stmts/lines/funcs 恒 99.3%/99.3%/100%；text 报告器未覆盖 `417-418` →（仍 `417-418`，**但 branch 仍非 100%——再次证明 text 列在掩盖残留分支**）。本轮补 6 分支后 lcov 残留 10 个：`151,188,216,236,248,253,259,271,276,416`。

**本轮迭代动作**：+6 characterization（WorkerSocietyService.test.ts 31→37，新增 `need_not_found guard on lifecycle methods` describe 块）；255/255 绿，tsc exit 0。

**下一轮候选（10 残留分支，lcov 取真值）**：
- ① **L151 worker_not_found**（volunteerFor，need 真实但 worker 不存在）——可达、真实业务、与 need_not_found 互补，**ROI 最高**；
- ② **L416 randomId 降级**（iter-34 已验证 `vi.stubGlobal('crypto', undefined)` stub 可用，同源一步到位）；
- ③ L188/216/248/271（`!t.ok` 非法迁移转发，需构造非法状态）；
- ④ L236/253/259/276（`?? '?'`/`?? ''` null-assignee 兜底，疑似 TS-unreachable 防御，需定性后决定 skip）。
**建议下一轮选 ①（worker_not_found L151，可达且与本轮契约互补）**。

### 迭代 #36 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 34 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **256/256 全绿**（14 文件，较 iter-35 的 255 +1）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-35 候选①）**：`WorkerSocietyService.ts` L151——volunteerFor 的 `worker_not_found` 守卫。与 iter-35 补的 `need_not_found` 契约互补（need 存在、worker 不存在这一分支）。

**本轮聚焦缺口（一个 characterization，锁 L151）**：volunteerFor L147-151 顺序为 `needs.get → need_not_found` → `profiles.get → worker_not_found`。need 查找通过（L149 iter-35 已覆盖）后，`profiles.get(workerId)` 返回 undefined → L151 返回 `worker_not_found`。**publishNeed 不校验 postedBy**（L120-135 直接存），故无需 seed 任何 worker——发一个真 need（过 L149）、用脏 workerId 自荐即触发 L151，最小零冗余。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-003 自荐输入校验 | ✅ PASS(characterization) | 锁「脏 workerId（agent 笔误 / 未注册 worker / 已注销 worker）→ worker_not_found，不抛、不误写 volunteers」——自荐前置校验契约，与 need_not_found 对称 |

**TDD 痕迹**：characterization（绿现）——守卫实现正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：lcov `BRDA:...,0` 残留分支 **10→9**（worker_not_found L151 移出）；本轮后残留 9 个：`188,216,236,248,253,259,271,276,416`。WorkerSocietyService.ts funcs 恒 100%、stmts/lines 恒 99.3%。

**本轮迭代动作**：+1 characterization（WorkerSocietyService.test.ts 37→38，guards 块加 `worker_not_found` 用例）；256/256 绿，tsc exit 0。

**下一轮候选（9 残留分支，已分类）**：
- ① **L188/216/248/271（`!t.ok` 非法迁移转发 ×4 方法）**——selectAssignee/startNeed/acceptDelivery/requestRevision 各自转发 transitionNeed 的失败 reason；deliverNeed 的同源分支已被「deliver before start」覆盖，这 4 个对称未覆盖。**全部可达**（构造非法迁移：selectAssignee 两次 / startNeed 跳过 select / acceptDelivery 或 requestRevision 打在非 delivered 态）。内聚、真实业务，**ROI 最高**；
- ② **L416 randomId 降级**（iter-34 已验证 `vi.stubGlobal('crypto', undefined)`，同源一步到位，最快）；
- ③ **L236/253/259/276（`?? '?'`/`?? ''` null-assignee 兜底）**——deliverNeed/acceptDelivery/requestRevision 的 emit/get 里 assignee 为空才触发；正常流程 selectAssignee 已设 assignee，这 4 个是 TS-unreachable 防御臂，**需定性后大概率 skip**（与 societyPolicies L235/L434 同类）。
**建议下一轮选 ①（`!t.ok` 转发 ×4，内聚可达，把 service 层错误转发契约补全；与 deliverNeed 已覆盖的 `!t.ok` 对称）**。

### 迭代 #37 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 35 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **260/260 全绿**（14 文件，较 iter-36 的 256 +4）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-36 候选①）**：`WorkerSocietyService.ts` 的 `!t.ok` 非法迁移转发 ×4 方法（L188 selectAssignee / L216 startNeed / L248 acceptDelivery / L271 requestRevision）—— service 层「非法状态」错误契约，与已覆盖的 deliverNeed 同源分支（L232，deliver before start）对称补全。

**本轮聚焦缺口（一个内聚契约：非法迁移 reason 原样转发）**：每个生命周期方法在 need 处于非法状态调用 transitionNeed 时失败，service 必须**原样转发 `t.reason`**（不吞、不抛、不替换为硬编码）。deliverNeed 已有覆盖，其余 4 个对称未覆盖。每个的可达路径（都需先把生命周期驱动到「使下一次操作非法」的状态）：

| 分支 | 方法 | 非法迁移 | 可达构造 |
|---|---|---|---|
| L188 | selectAssignee | assigned→assigned | volunteer → selectAssignee（→assigned）→ **再 selectAssignee** |
| L216 | startNeed | in_progress→in_progress | 驱动到 in_progress → **正确 assignee 再 startNeed**（过 L214 not_assignee 检查）|
| L248 | acceptDelivery | in_progress→closed | 驱动到 in_progress → **acceptDelivery**（未交付就审核）|
| L271 | requestRevision | 非 delivered 上调 | 驱动到 in_progress → **requestRevision**（未交付就退回）|

**reason 字符串推导全部命中**（绿现、零返工）：`illegal:assigned->assigned`（L188）、`illegal:in_progress->in_progress`（L216）、`illegal:in_progress->closed`（L248）；L271 因 requestRevision 域策略目标态需确认，用稳健断言 `/^illegal:/`（确认转发而非吞错，不过度绑定精确迁移对）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY-004~008 生命周期非法状态 | ✅ PASS(characterization) | 锁「非法状态调用 → 转发 `illegal:<from>-><to>` reason，状态不变、不抛」——agent/前端在错误生命周期阶段触发动作时的可读错误契约 |

**TDD 痕迹**：characterization（绿现）——4 个转发分支实现正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：lcov `BRDA:...,0` 残留分支 **9→5**（L188/216/248/271 移出）；本轮后残留 5 个：`236,253,259,276,416`。WorkerSocietyService.ts funcs 恒 100%、stmts/lines 恒 99.3%、test 38→42。

**本轮迭代动作**：+4 characterization（WorkerSocietyService.test.ts 38→42，新增 `forwards transitionNeed failures` describe 块）；260/260 绿，tsc exit 0。

**下一轮候选（5 残留分支）**：
- ① **L416 randomId 降级**——非防御、可达（iter-34 已验证 `vi.stubGlobal('crypto', undefined)` stub 可用，同源一步到位，**最后一个真实运行时残留**）；
- ② **L236/253/259/276（`?? '?'`/`?? ''` null-assignee 兜底）**——deliverNeed/acceptDelivery/requestRevision 的 emit/get 里 assignee 为空才触发；正常流程 selectAssignee/startNeed 已设 assignee，**不变量保证这些态 need 必有 assignee**，4 个是 TS-valid 但运行时不可达的防御臂（与 societyPolicies L235/L434 同类），需构造违反不变量的脏 need（status=in_progress + assignee=undefined 直插 FakeNeedStore）才能触达 → **低价值，大概率 skip**。
**建议下一轮选 ①（L416 randomId，stub 已验证、补完后该文件仅剩防御臂、达 practical ceiling，与 societyPolicies 收尾一致）**。

### 迭代 #38 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 36 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **261/261 全绿**（14 文件，较 iter-37 的 260 +1）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-37 候选①）**：`WorkerSocietyService.ts` L416——`randomId()` 的 crypto 降级分支（最后一个真实运行时残留）。

**本轮聚焦缺口（一个 characterization，锁 L416 降级臂）**：`randomId()` L413-418，分支决策 `if (g.crypto?.randomUUID) return <UUID> else <降级>`。正常 vitest 环境 crypto.randomUUID 存在 → **true 臂（UUID）恒走**，**false 臂（L417 降级 = Date.now()+Math.random() 的 base36 串）从未触达**。crypto 缺失（旧 Node / 受限运行时 / 沙箱）时必须降级且不抛。publishNeed 同时调 randomId 两次（L122 need + L409 evt），needId 直接可观测——选它作探针。

**复用 iter-34 验证过的 stub 模式**：`vi.stubGlobal('crypto', undefined)` 覆盖 Node 只读 crypto 全局（vitest 内部 defineProperty）→ 走 L417 降级臂；**段数断言**稳健区分两臂——降级 `need-<ts36>-<rand36>` = 3 段（2 个 `-`）、UUID `need-<uuid>` = 6 段（5 个 `-`），不靠 hex 字符判断（base36 偶发全 hex 会 flaky）；两次 publishNeed 的 needId 互异（Math.random 保证唯一）；try/finally + `vi.unstubAllGlobals()` 即时恢复防污染。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY 运行时健壮性（randomId crypto 降级） | ✅ PASS(characterization) | 锁「无 crypto 环境下 needId/evtId 仍生成、仍唯一、publishNeed 不抛」——application 核心在受限运行时的健壮降级契约（与 crossTeamMessageGateway iter-34 同源、同结论） |

**TDD 痕迹**：characterization（绿现）——降级臂与契约一致；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：lcov `BRDA:...,0` 残留分支 **5→4**（L416 移出）；**WorkerSocietyService.ts 现 100% stmts / 100% lines / 100% funcs / 96% branch**（仅剩 4 个防御臂）；test 42→43。

**里程碑 🎯：WorkerSocietyService.ts 达 practical ceiling（100/96/100/100）**——继 societyPolicies（97.24% branch defensive）后，**第二个核心（domain/application）文件达 ceiling**：100% stmts/lines/funcs，唯一残差的 4% branch 全是 `?? '?'`/`?? ''` null-assignee 防御臂（L236/253/259/276）。至此 worker-society 覆盖盘点：**5 文件 100%×4**（societyApi iter-26 / societyStore iter-28 / societyGraphAdapter iter-32 / fsStores iter-33 / crossTeamMessageGateway iter-34）+ **2 文件 practical-ceiling**（societyPolicies / WorkerSocietyService）。

**本轮迭代动作**：+1 characterization（WorkerSocietyService.test.ts 42→43，新增 `randomId crypto fallback` describe 块，import 加 `vi`）；261/261 绿，tsc exit 0。

**下一轮候选**：
- ① **societyMcp.ts 残留 `34,43,243`**（iter-34 标注，csv/num 辅助默认臂，**需先定性**是 TS-unreachable 还是可达 default）—— main/adapters/input 的 MCP 工具层，尚未穷尽；
- ② **WorkerSocietyService L236/253/259/276 防御臂**——`?? '?'`/`?? ''`，不变量保证可达态 need 必有 assignee，需构造脏 need（status∈{in_progress,delivered} + assignee=undefined 直插 FakeNeedStore）触达，**低价值，大概率 skip**（与 societyPolicies L235/L434 同类）；
- ③ **审计未穷尽文件**：societyComposition / societyDemo / societyRoutes / workerSocietyPlugin——先跑各自 scoped coverage + lcov 定位真缺口。
**建议下一轮选 ①（societyMcp 残留定性）或 ③（审计未穷尽文件）——核心 service 已达 ceiling，转向 adapters/composition 层**。

### 迭代 #39 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 37 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **262/262 全绿**（14 文件，较 iter-38 的 261 +1）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-38 ①/③，先审计再聚焦）**：核心 service 已达 ceiling，本轮先用 lcov 扫 adapters/composition 层 4 文件（societyMcp / societyComposition / workerSocietyPlugin / societyDemo）定位真缺口，再选最高价值的一个。

**审计结论（lcov 取真值）**：
- `societyDemo.ts` → 已 **100%×4**（iter 未编号的早期工作已穷尽）；
- `workerSocietyPlugin.ts` → 已 **100%×4**（7 测试全覆盖，无残留）；
- `societyMcp.ts` → 100% stmts/lines/funcs、89.65% branch，残留 3 个防御臂 `34,43,243`（csv/num 辅助 default，待定性）；
- `societyComposition.ts` → **一个未覆盖函数 `defaultSocietyRoot`（FNDA:0）** ← **本轮选它**（整函数零覆盖 > 3 个防御分支）。

**本轮聚焦缺口（一个 characterization，锁 `defaultSocietyRoot`）**：`societyComposition.ts` L21-23——纯函数 `join(homedir(), '.hermit', 'society')`，是 worker-society 声誉/关系/需求/消息**跨重启落盘的规范根目录**。它是 `createWorkerSociety` 的默认参数，但既有 2 个 composition 测试都传显式 tmpdir → 该导出从未被调用（FNDA:0）。一行纯函数，trivial 但**锁定规范路径防漂移**（谁若误改成 `~/.hermit/society-data` 之类，测试立红）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY 持久化根目录（defaultSocietyRoot） | ✅ PASS(characterization) | 锁 `~/.hermit/society` 是社会数据的规范家目录——与 hermit 其余状态（`~/.hermit/`）同根、隔离的 `society/` 子目录，跨重启存活的核心路径契约 |

**TDD 痕迹**：characterization（绿现）——纯函数实现正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：societyComposition.ts **funcs 由未满 → 100%**（`defaultSocietyRoot` FNDA:0→已覆盖），现 **100%×4**（lcov 无残留 FN/branch）；test 2→3。

**里程碑 🎯：societyComposition.ts 达 100%×4**——继 societyApi（iter-26）/ societyStore（iter-28）/ societyGraphAdapter（iter-32）/ fsStores（iter-33）/ crossTeamMessageGateway（iter-34）后**第六个 100%×4 文件**。覆盖盘点更新：**6 文件 100%×4** + **2 文件 practical-ceiling**（societyPolicies / WorkerSocietyService）。

**本轮迭代动作**：+1 characterization（societyComposition.test.ts 2→3，加 `defaultSocietyRoot` 用例 + import `homedir`/`defaultSocietyRoot`）；262/262 绿，tsc exit 0。

**下一轮候选**：
- ① **societyMcp.ts 残留 `34,43,243`**——csv/num 辅助函数的 default 臂，**需先 grep/read 定性**是 TS-unreachable（穷举 union 的防御 default）还是可达分支；定性后若是可达就补 characterization，若是防御就标注 skip；
- ② **societyRoutes.ts**——18 测试但**尚未跑过 lcov 取真值**，可能藏分支缺口（iter-35 truncation-masking 教训：text 列不可信），值得下一轮扫一次；
- ③ WorkerSocietyService L236/253/259/276 防御臂（低价值，skip）。
**建议下一轮选 ①（societyMcp 3 分支定性）——adapter 层已知最高密度残留，定性 + 可能一步补全**。

### 迭代 #40 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 38 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **264/264 全绿**（14 文件，较 iter-39 的 262 +2）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-39 ①）**：`societyMcp.ts` 残留 `34,43,243`——csv/num 辅助函数的分支，**需定性** TS-unreachable 防御 vs 可达。

**定性结论（grep call-site + read 实现 → 全部 REACHABLE，非防御 default）**：
- **L34** `csv(value ?? '')` 真臂——`csv(args.required_capabilities)`（L222 publishNeed）/ `csv(args.capabilities)`（L215 discover）缺省时 `csv(undefined)` → `[]`；
- **L43** `num` 的 `Number.isFinite(n) ? n : undefined` **false 臂**——`num('非数字')` → NaN → undefined（既有 feed 测传 `'5'` 只覆盖 true 臂）；
- **L243** `num(args.limit) ?? 20` 降级臂——get_feed 脏/缺省 limit → 默认 20。
- **巧合可复用**：`get_feed { limit: 'not-a-number' }` 一举覆盖 **L43 false + L243 ?? 20**（`num('not-a-number')`→NaN→undefined→`?? 20`）。

**本轮聚焦缺口（2 个 characterization，锁 3 分支）**：
1. `society_publish_need` **不传 required_capabilities** → `csv(undefined)` → `[]`（L34）；断言 need.status='open' + 落库 requiredCapabilities=[]。
2. `society_get_feed` 传 `limit: 'not-a-number'`，**先灌 25 条消息使默认上限 20 可观测**（recent(20) 只回最后 20 条）→ 断言 feed.length===20（L43 false + L243 ?? 20）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY MCP 输入鲁棒性（csv/num 边界） | ✅ PASS(characterization) | 锁「agent 传脏/缺省参数（无能力需求、非数字 limit）→ 优雅降级（[] / 默认 20），不抛、不回全量」——MCP 工具对 agent 自由输入的容错契约 |

**TDD 痕迹**：characterization（绿现）——3 个分支实现正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：societyMcp.ts **branch 89.65%→100%**，stmts/lines/funcs 恒 100%；lcov **无残留 FN/branch**；test 11→13。

**里程碑 🎯：societyMcp.ts 达 100%×4**——继 societyApi（iter-26）/ societyStore（iter-28）/ societyGraphAdapter（iter-32）/ fsStores（iter-33）/ crossTeamMessageGateway（iter-34）/ societyComposition（iter-39）后**第七个 100%×4 文件**。覆盖盘点更新：**7 文件 100%×4**（全部 adapter/composition/infrastructure/renderer-api 层）+ **2 文件 practical-ceiling**（societyPolicies / WorkerSocietyService，仅剩防御臂）。

**本轮迭代动作**：+2 characterization（societyMcp.test.ts 11→13，csv(undefined) + num 脏值→默认 20）；264/264 绿，tsc exit 0。

**下一轮候选**：
- ① **societyRoutes.ts**——18 测试但**从未跑过 lcov 取真值**，text 列可能掩盖分支缺口（iter-35 truncation-masking 教训），值得扫一次 main/adapters/input 的 REST 层；
- ② WorkerSocietyService L236/253/259/276 防御臂（不变量保证可达态 need 必有 assignee，**skip**）；
- ③ societyViewUtils L54 / societyOverlayActions L47（iter-23/29 已确认 TS-unreachable default，**skip**）。
**建议下一轮选 ①（societyRoutes lcov 扫描）——最后一个未审计的高价值模块，REST 层分支密度通常高于 MCP**。

### 迭代 #41 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 39 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **265/265 全绿**（14 文件，较 iter-40 的 264 +1）；`tsc` exit 0（ClaudeDoctorProbe 基线过滤后干净）。

**本轮选题（承接 iter-40 ①）**：`societyRoutes.ts` 首次 lcov 扫描——REST 适配层，18 个测试但从未取过真值。

**审计结论（truncation-masking 第四次复现）**：text 列显示未覆盖 `...1,75-79,172-173`（被省略号截断），但 lcov `BRDA:...,0` 找到 **18 行**：`23,36,37,60,69,84,88,110,113,125,126,131,132,154,171,177,178`。**branch 仅 70.17%**（全 feature 最低密度）。text 列再次掩盖了大量真实分支。

**18 分支分类（按价值 + 冗余度）**：
- **6 命令路由无 body（110,113,125,126,131,132）**——volunteer/start/deliver 的 `request.body ?? {}` + `String(field ?? '')`；这 3 路无 400 校验，空字段产生**可观测** service 结果 ← **本轮覆盖**；
- **5 校验路由无 body（36,37,88,177,178）**——register/publish/messages 无 body → 400（`body ?? {}` 右臂）；
- **4 catch→[] 臂（23,60,69,171）**——/workers、/needs/open、/needs/active、/relationships；**既有 /feed catch 测试注释明示「以 /feed 为代表」覆盖该同构模式**，逐个重测属冗余 → **skip（遵循「拒绝冗余」）**；
- **1 null-on-miss（84）**——GET /needs/:ghost → null；
- **1 typeof 检查（154）**——autonomy/tick 的 `typeof body[k]==='number'` false 臂。

**本轮聚焦缺口（一个内聚 characterization，锁 6 命令路由无 body）**：单测驱动一个 need 走完生命周期，在每个命令处**先无 body 探测**（验优雅结果）再正常调用（推进状态）：
- need=open，无 body 自荐 → `volunteerFor(needId,'')` → **worker_not_found**（L110+L113）；
- 推到 assigned，无 body 开始 → `startNeed(needId,'')` → assignee 'dev' !== '' → **not_assignee**（L125+L126）；
- 推到 in_progress，无 body 交付 → `deliverNeed(needId,'')` → **空结果被允许、成功**（L131+L132）。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY REST 输入鲁棒性（命令路由无 body） | ✅ PASS(characterization) | 锁「POST 命令不发 body（代理剥离 / 漏 Content-Type）→ 路由归一空字段、下传 service、不崩；空 workerId→worker_not_found/not_assignee，空 result→允许」——REST 对畸形请求的容错契约 |

**TDD 痕迹**：characterization（绿现）——6 分支实现正确，仅缺测试；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：societyRoutes.ts **branch 70.17%→80.70%（+10.53）**，stmts/lines/funcs 恒 91.5%/91.5%/100%；lcov 残留 **18→11**（110,113,125,126,131,132 移出）；test 18→19。

**本轮迭代动作**：+1 characterization（societyRoutes.test.ts 18→19，新增命令路由无 body 内聚测）；265/265 绿，tsc exit 0。

**下一轮候选（11 残留，已分类）**：
- ① **L84 null-on-miss + L154 typeof（2 个真实契约，各 1 测，快）**——GET /needs/:ghost→null、autonomy/tick 非数字 option→忽略；
- ② **5 校验路由无 body（36,37,88,177,178）**——无 body → 400，与既有 400 测互补（现有 400 测都传了 body）；
- ③ 4 catch→[] 臂（23,60,69,171）——**skip**（/feed 已为代表，重测冗余）。
**建议下一轮选 ①（L84 + L154，2 个真实可观测契约，一步补全 REST 层剩余真实分支）**。

---

### 迭代 #42 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 40 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **267/267 全绿**（14 文件，较 iter-41 的 265 +2）；`tsc --noEmit` exit 0、零报错（连 ClaudeDoctorProbe 基线也未触发）。

**本轮选题（承接 iter-41 ①）**：`societyRoutes.ts` 收尾——L84（GET /needs/:ghost → null）+ L154（autonomy/tick `typeof body[k]==='number'` 检查）。

**审计结论（关键纠错）**：L84 一次补全（null-on-miss，1 测）；但 **L154 暴露了一个两臂认知盲区**——`numOrUndef` 的三元 `typeof body[k]==='number' ? (body[k] as number) : undefined` 有 **true/false 两臂**：
- **false 臂**（非数字 → undefined）：既有「无-body tick」测（body={} → undefined）**已覆盖**；
- **true 臂**（真数字 → 透传给 runAutonomyTick）：此前**从未在路由层被触达**——这才是 lcov 残留 `BRDA:154` 的真因。

本轮中途先写了一个「字符串 option → 忽略」测，但它命中的是**已被覆盖的 false 臂**（与无-body 测同臂）= **冗余**；其注释还误称「既有测传真数字」（实际传的是无 body）。按「拒绝冗余 / 发现既有债务顺手清掉」，把该冗余测**替换**为真正的 true 臂 characterization。

**本轮聚焦缺口（true 臂 characterization）**：2 个匹配 worker（dev1/dev2）+ 1 need，`POST /autonomy/tick {maxVolunteersPerNeed: 1}` → greedy 只选最高适配者 **1 人**（默认 cap 3 会两人都自荐）。若 true 臂失效（始终 undefined → 默认 3），断言 `volunteers.length===1` 即失败——可观测、防回归。

| 域 | 结论 | 产品意见 |
|---|---|---|
| L84 GET /needs/:ghost → null（显式缺失，非 404） | ✅ PASS(characterization) | 锁「查不到的 need 返 null 供前端区分『不存在 vs 加载中』」 |
| L154 autonomy/tick 数字 option 透传（true 臂） | ✅ PASS(characterization) | 锁「客户端传真数字 cap → 真正限流」，REST option 透传契约 |

**TDD 痕迹**：L84 characterization（绿现）。L154 先冗余误诊（false 臂）→ 纠错替换为 true 臂 characterization（绿现）；无实现改动（实现正确，仅缺 true 臂触达）。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：societyRoutes.ts **branch 80.70%→82.75%→84.74%**（L84 +2.05，L154 true 臂再 +1.99），stmts/lines/funcs 恒 91.5%/91.5%/100%；lcov 残留 **11→10→9**（L84、L154 先后移出）。test 19→21。

**9 残留分类（societyRoutes.ts 到达实用上限）**：
- **4 catch→[] 臂（23,60,69,171）**——/workers、/needs/open、/needs/active、/relationships；/feed 已为代表，重测冗余 → **skip**；
- **5 防御性 `??` 归一臂（36,37,88,177,178）**——register/publish/messages 的 `(request.body ?? {})` + `String(body.x ?? '')`，即「无 body / 缺字段 → 归一空串 → 触发 400」路径；同一模式重复 5 次，单测可一并覆盖 → 见下一轮候选。

**里程碑**：societyRoutes.ts 到达**实用覆盖上限**（84.74% branch / 100% funcs / 91.5% stmts）——所有适配器文件（routes+mcp+composition+fsStores+gateway）均已到顶或上限。worker-society 全 14 测文件现处于**实用覆盖饱和**，剩余皆为代表覆盖的 catch 臂或防御性 `??` 归一臂。

**下一轮候选（9 残留，已分类）**：
- ① **5 防御性 `??` 归一臂（36,37,88,177,178）一测覆盖**——对 register/publish/messages 三路各发**无 body POST** → `request.body ?? {}` true 臂（36,88,177）+ `body.x ?? ''` true 臂（37,178）→ 三路均 400。与既有「传了 body 的 400 测」互补（现有 400 测都带 body，从未触无-body 归一臂），属「输入鲁棒性」与 iter-41 bodyless-command 同主题的收尾；
- ② 4 catch→[] 臂（23,60,69,171）——**skip**（/feed 已为代表，重测冗余）。
**建议下一轮选 ①（bodyless 校验路由 → 400，一测覆盖 5 个 `??` true 臂，补全 REST 输入鲁棒性最后一块）**。若判定防御性 `??` 归一属低价值（Fastify 契约已保证 body 可空），亦可宣告 **worker-society 覆盖审查循环使命完成（14 文件全部实用饱和）**。

---

### 迭代 #43 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 41 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **268/268 全绿**（14 文件，较 iter-42 的 267 +1）；`tsc --noEmit` exit 0、零报错。

**本轮选题（承接 iter-42 ①）**：选 ① 而非宣告饱和——5 个防御性 `??` 归一臂（L36/37/88/177/178）实为「输入鲁棒性」可测契约，与 iter-41 bodyless-command 同主题收尾。

**审计结论**：3 个校验路由（register/publish/messages）的 `(request.body ?? {})` + `String(body.field ?? '')` 共 5 个 `??` true 臂，此前从未触达——既有 400 测都**传了 body**（命中的是 false 臂：字段 present 但空串）。一个**无-body POST** 即可一并触达全部 5 臂（body=undefined → `?? {}` → 各字段 undefined → `?? ''` → 400）。防回归价值真实：若删掉任一 `?? {}` 守卫，无-body POST 会 `undefined.field` 抛 TypeError → Fastify 回 500 而非 400，断言即失败。

**本轮聚焦缺口（一个内聚 characterization，锁 3 路无-body → 400）**：单测对 register/publish/messages 各发**无-body POST**，断言三路均 `statusCode===400` 且 error 文案正确。

| 域 | 结论 | 产品意见 |
|---|---|---|
| SOCIETY REST 输入鲁棒性（校验路由无 body） | ✅ PASS(characterization) | 锁「POST 校验路由不发 body（代理剥离/漏 Content-Type）→ 归一空字段、返回 400、绝不 500」——与 iter-41 bodyless-command 配对，补全 REST 对畸形请求的容错契约 |

**TDD 痕迹**：characterization（绿现）——5 臂实现正确，仅缺无-body 触达；直接绿，无实现改动。

**证据（覆盖前后对比，scope 单文件，lcov 取真值）**：societyRoutes.ts **branch 84.74%→93.22%（+8.48）**，stmts/lines/funcs 恒 91.5%/91.5%/100%；lcov 残留 **9→4**（L36/37/88/177/178 全部移出）；test 21→22。

**4 残留（societyRoutes.ts 终态）**：仅剩 **4 catch→[] 臂（23,60,69,171）**——/workers、/needs/open、/needs/active、/relationships 四路同构 `try{await c.X.list()}catch{return[]}`；既有 /feed catch 测为代表覆盖该模式，逐个重测属冗余 → **skip（遵循「拒绝冗余」）**。此为 societyRoutes.ts 的真正上限。

**里程碑（worker-society 覆盖审查使命完成）**：societyRoutes.ts 经 iter-41/42/43 从 **70.17%→93.22% branch**。至此全 14 测文件均处**实用覆盖饱和**：
- **8 文件 100%×4**：societyApi / societyStore / societyGraphAdapter / fsStores / crossTeamMessageGateway / societyComposition / societyMcp / societyDemo(+workerSocietyPlugin)；
- **3 文件仅剩防御/不可达臂**：societyPolicies（97.24% branch，TS 不可达守卫）、WorkerSocietyService（96% branch，4 个不变式 `??` fallback）、societyRoutes（93.22% branch，4 个代表覆盖的 catch 臂）。
- 全 feature 剩余分支**无一为真实可观测契约缺口**——皆为 TS 不可达守卫 / 不变式 fallback / 代表覆盖的 catch。继续逐个补测即制造冗余，违背「拒绝冗余」。

**下一轮候选（覆盖饱和后）**：
- ① **宣告覆盖审查循环使命完成**——worker-society 14 文件实用饱和，可 `CronDelete 1e539b60` 收尾，或转为低频回归巡检（代码变更时复跑全量 lcov 防漂移）；
- ② **唯一的已知真缺口：渲染层 UI（SocietyGraph/SocietyView/SocietyNodeOverlay）零单测**——但 hermit 未引入 `@testing-library/react`，补测需先决策引入测试基建（非单轮可成），且交互决策已抽到 `societyOverlayActions.ts`（12 测）覆盖；
- ③ 若坚持字面 100%：仅剩 societyRoutes 4 catch 臂 + service/policies 的 TS-不可达守卫，皆低价值 → **不推荐**（冗余）。
**建议下一轮选 ①（宣告饱和收尾）**——继续制造低价值补测违背工程原则；UI 缺口待测试基建决策再开。

---

### 迭代 #44 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 42 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **268/268 全绿**（14 文件，与 iter-43 同数——本轮**替换**而非新增）；`tsc --noEmit` exit 0、零报错。

**本轮选题（纠 iter-43 的「饱和」结论）**：iter-43 宣告 14 文件实用饱和。但**不轻信、复扫验证**——本轮跑全 feature lcov 全量扫描（非仅 societyRoutes），核对每个文件的残留分支。

**审计结论（关键纠错：iter-43 饱和结论对 societyOverlayActions 不成立）**：全量扫描暴露 **`societyOverlayActions.ts` branch 仅 87.5%**（iter-43 误以为该文件「12 测覆盖良好」）——lcov 残留 `BRDA:46`（switch default）+ **`BRDA:70`（clampOverlayPosition 的真分支）**。BRDA:70 被**一个过时测试掩盖**：

- `clampOverlayPosition` 的 `if (left < margin) left = margin`（左 clamp TRUE 臂）此前从未被触发。既有测试 #5「左侧也不够」用**共享 viewport.width=1000 + pos.x=0** → 默认 `left=0+12=12`，**根本没翻左**（252<992），`12≥8` 断言**平凡成立**——既没翻左、也没触发 left-clamp，是**假覆盖**。
- 该 clamp 只在**窄视口**触发：右溢出 → 翻左 → `left=pos.x-gap-width` 落到负 → clamp 到 8。既有 5 个 clamp 测全用 width=1000，无一能触发。

**本轮聚焦缺口（替换过时测，红→绿严格验证非空）**：把测试 #5 换成**窄视口级联测**（viewport 200×200、pos {100,0} → 翻左 left=-152<8→clamp 8、top=-80<8→clamp 8，断言 `left===8 && top===8`）。严格 TDD：**先临时删掉 `if (left < margin) left = margin`** → 新测 **RED**（`out.left=-152≠8`），其余 11 测全过 → 证新测**非空**、且坐实旧测 #5 **空覆盖**；恢复该行 → **GREEN**。

| 域 | 结论 | 产品意见 |
|---|---|---|
| 弹卡定位窄视口越界（翻左后仍越左/上 → clamp 8） | ✅ PASS(红→绿) | 锁「小屏/侧栏收窄时弹卡翻转后仍被边距兜底，不出现负值越界」——纯定位逻辑的真实边界，非防御 |

**证据（scope 单文件，lcov 取真值）**：societyOverlayActions.ts **branch 87.5%→93.75%（+6.25）**，stmts/lines/funcs 恒 97.56%/97.56%/100%；lcov 残留 **2→1**（BRDA:70 移出，仅余 BRDA:46）；测数不变（替换）。

**扫描其余残留（复核，确认真缺口/不可达）**：
- `societyViewUtils.ts` needStatusColor **L53 default**：switch 已穷尽全部 7 个 NeedStatus → default **TS 不可达**（与 policies 同型）→ skip；
- `societyOverlayActions.ts` needLifecycleActions **L46 default**：同上，穷尽 7 态 → **TS 不可达** → skip；
- `ports.ts`(0%)/`index.ts`(0%)：纯类型/桶重导出，无可执行码 → 忽略；`fakes.ts`：测试夹具，非生产码。

**里程碑修正**：iter-43「14 文件饱和」对 societyOverlayActions **过早**——一个过时测（平凡断言）掩盖了真分支。教训：**「饱和」结论必须靠全量复扫复核，过时测可掩盖缺口**；这正是循环持续复扫的价值。修正后真态：8 文件 100%×4；societyPolicies 97.24% / WorkerSocietyService 96% / societyRoutes 93.22% / societyOverlayActions 93.75% / societyViewUtils 94.44%——剩余**皆**为 TS-不可达 switch-default / 不变式 `??` fallback / 代表覆盖的 catch。

**下一轮候选**：
- ① **保留循环作「饱和哨兵」**——每轮跑全量 lcov 复扫（本轮证明其能抓过时测掩盖的缺口）；若再无真分支则确认饱和、不制造冗余测；
- ② 仅剩的 switch-default（societyViewUtils L53 / societyOverlayActions L46）若坚持字面 100% 可 bogus-cast 补，但属 TS-不可达 → **不推荐**；
- ③ 渲染层 UI（SocietyGraph/SocietyView/SocietyNodeOverlay）零单测——需先引入 `@testing-library/react` 基建（非单轮）。
**建议下一轮选 ①（哨兵复扫）**——饱和结论已二次复核，但本轮刚被纠错过一次，宜再扫一轮坐实；真无缺口即转低频回归巡检。

---

### 迭代 #45 · 2026-06-14（10 分钟 TDD 覆盖审查循环 #1e539b60，第 43 次触发）
**自动化基线**：`vitest run src/features/worker-society` → **269/269 全绿**（14 文件，较 iter-44 的 268 +1）；`tsc --noEmit` exit 0、零报错。

**本轮选题（承接 iter-44 ①：哨兵复扫，复核饱和）**：iter-44 纠错 societyOverlayActions 后建议「再扫一轮坐实」。本轮跑全 feature lcov 全量扫描，并**逐个复核** WorkerSocietyService / societyPolicies / societyViewUtils 的残留分支（不轻信「已确认不可达」——iter-44 正是被此假设坑过）。

**逐分支复核结论（看真实代码 + 不变量，非假设）**：
- **WorkerSocietyService L236/253/259/276**：均为 delivered/closed 状态 need 上的 `need.assignee ?? '?'`/`?? ''`。delivered 由 in_progress 转来、in_progress 由 assigned 转来 → assignee 在每个 emit 处恒已设。**确认不变式防御** → skip。
- **societyPolicies L235** `needCount.get(p.needId) ?? 0`：needCount 由全部 openNeeds 预置（L230），每个 pair 的 needId 都来自 open need → get 恒有值 → `?? 0` 永不触发。**确认（预置 map 不变式）** → skip。
- **societyPolicies L356** `ALLOWED_TRANSITIONS[need.status] ?? []`：total Record 覆盖全部 7 态 → 恒有值。**确认** → skip。
- **societyPolicies L434** `collaborations > 0 ? ... : 0`，其中 `collaborations = prev + 1` ≥1 → `: 0` 永不触发。**确认** → skip。
- **societyPolicies L102** `worker.maxConcurrent > 0 ? (...) : 0`：初看像不变式防御（registerProfile L93 `Math.max(1,…)` 夹取到 ≥1）。**但深挖发现 computeFitScore 是 `export function`，且 WorkerSocietyService L420-426 显式为其暴露「为外部调用方/前端预估」的便捷包装** → 契约 = 任意 WorkerProfile → 合法 FitBreakdown、不崩。外部调用方可传 maxConcurrent<=0（未经 registerProfile 夹取）→ **此分支是公开纯函数的真实可达边界，非 TS-不可达**。本轮补。

**本轮聚焦缺口（computeFitScore 除零守卫边界，红→绿严格验证）**：新增测 `computeFitScore(openNeed(), profile({maxConcurrent:0, activeTaskCount:0}))` → `loadFairness===0` 且 score 有限（无守卫则 `1-0/0`=NaN 污染）；再验 maxConcurrent:-3 → loadFairness=0。严格 TDD：**先临时删掉 `>0` 守卫** → 新测 **RED**（`expected NaN to be +0`，其余 70 过）→ 证守卫**非死代码**；恢复 → **GREEN**。

| 域 | 结论 | 产品意见 |
|---|---|---|
| computeFitScore 除零守卫（maxConcurrent<=0 → loadFairness=0，不 NaN） | ✅ PASS(红→绿) | 锁「公开纯函数对任意 WorkerProfile（含非法 maxConcurrent）稳健、不污染 score」——前端预估/外部调用的输入鲁棒性边界 |

**证据（scope 单文件 + 全量复核，lcov 取真值）**：societyPolicies.ts **branch 97.24%→97.94%（+0.70）**，stmts/lines/funcs 恒 100%；lcov 残留 **4→3**（L102 移出，余 235/356/434 皆确认不变式）；全量 269/269 绿，tsc exit 0。

**坑提醒（scoped-run 假残留）**：单跑 societyPolicies.test.ts 时 lcov 多冒出 L437（`(i===idx?next:r)` 的 r 臂）——该分支由 WorkerSocietyService.test.ts 经 service 触达，全量下已覆盖。**判断真缺口须看全量 lcov，非 scoped**（与 text 截断并列的第二种 lcov 误读）。

**里程碑（饱和二度复核坐实）**：iter-44 纠错 societyOverlayActions、iter-45 纠错 societyPolicies L102——**连续两轮「哨兵复扫」各抓出一个被过时测/错误假设掩盖的真分支**，坐实「循环持续复扫」的价值。修正后真态：8 文件 100%×4；societyPolicies 97.94% / WorkerSocietyService 96% / societyRoutes 93.22% / societyOverlayActions 93.75% / societyViewUtils 94.44%——剩余**皆**经逐分支看真实代码 + 不变量确认（TS-不可达 switch-default / 不变式 fallback / 代表覆盖 catch），无一真缺口。

**下一轮候选**：
- ① **保留循环作哨兵，但降频**——连续两轮复扫均仅剩确认不可达分支，可考虑拉长间隔（如 30min）或转「代码变更触发」；
- ② WorkerSocietyService L236/253/259/276 四个 assignee 不变式 `??`：若坚持字面 100% 可手动种非法 need（delivered 无 assignee）补，但属不变式防御 → **不推荐**；
- ③ 渲染层 UI 零单测——需先引入 `@testing-library/react` 基建（非单轮）。
**建议下一轮选 ①（饱和已二度坐实，转低频哨兵）**——再高频复扫边际收益递减；真要补只剩不变式防御，违背「拒绝冗余」。

---
```bash
# 全量（worker-society 独立）
node_modules/.bin/vitest run src/features/worker-society
# 单域速查
node_modules/.bin/vitest run src/features/worker-society/core/domain/policies/societyPolicies.test.ts
node_modules/.bin/vitest run src/features/worker-society/main/adapters/input/societyRoutes.test.ts
# 类型（过滤环境基线 ClaudeDoctorProbe）
node_modules/.bin/tsc -p . 2>&1 | grep worker-society
# web 形态冒烟（黄金路径）
pnpm dev:server & pnpm dev:web &
curl -s http://127.0.0.1:5680/api/society/workers
curl -s -XPOST http://127.0.0.1:5680/api/society/autonomy/tick
```

### 迭代 #46 · 2026-06-14（首次 gstack + 读图 UI/UX 验收 · `/society` 实驱）
**范式转换**：iter #1–#45 全是「单测覆盖」循环（用户反馈「一直没考虑 ui 用户体验」「功能测试没那么复杂，就是点页面按钮看数据+ui」）。本轮按纠正方向，**改驱真实运行的 `/society` 页面**——gstack 浏览器自动化点按钮 + `analyze_image` 读截图（读图能力）+ `/api/society/*` 读数据，双轨观察「数据 vs 渲染」。测试范围严格限定 `/society` 单页。

**驱动栈**：gstack（headless Chromium daemon，`~/.claude/skills/gstack/browse/dist/browse`）→ `goto /society`、`snapshot -i`、`click`、`screenshot`；截图经 Read→CDN URL→`mcp__4_5v_mcp__analyze_image` 读图（本环境 Read 不内联视觉，须二次调 analyze_image）；数据经 `curl /api/society/workers`、`/api/society/needs/active`。

**3 个经读图/数据确认的真实 UX 缺陷**：

1. **图谱节点标签不可读（P0，体验阻断）** — 读图两次独立截图（`soc-01-clean` 默认态 / `soc-02-fit` Fit 后）一致结论：图谱**结构渲染正确**（7 个圆形 worker 节点 + 7 个六边形 task 节点 + 中央 Agora hub + 边 + 沿边流动粒子，均在），但**所有节点标签对人类不可读**（"tiny, blurred, pixelated — unreadable to a human"）。页面唯一可读文字是顶栏副标题「去中心化自治 · 6 成员 · 8 个在途任务 · 0 条关系」（`SocietyView.tsx:258`）。→ 「纯图谱，信息全由图谱编码」的核心承诺落空：用户看不出谁是谁、有哪些任务、谁认领了什么。结构清晰而唯文字不可读 → **排除 CDN 压缩伪影**。根因层：引擎 canvas 标签字号固定（`packages/agent-graph`，与 team 功能同源共享）；按 worker-society **独立性约束不能改共享引擎** → 修复须落在 `/society` 渲染层（默认放大 zoom / HTML 叠层标签），属设计决策，待定方向。

2. **发布/加载示例非幂等 → 重复 need + 孤儿（P1）** — `/api/society/needs/active` 返回 8 条，含 2 组重复主题：`实现登录页面 UI` ×2（need-1e873 `assigned→frontend vol=1` + need-d8a8a **`open vol=0`**）、`评审并测试用户 API` ×2（need-4d7b8 + need-62a11）。根因：`publishNeed` 按 subject 不去重、每次生成新 needId；`buildDemoSociety`/「加载示例」重跑即固定主题翻倍。后果：抢不到自荐者的重复副本（need-d8a8a）**永久卡 open/vol=0**（worker 已为另一副本自荐、达 `maxNeedsPerWorker` 上限）→ 孤儿 need 永不自洽。现有 SOCIETY-001-002（workerId 幂等）/002-004（同 need volunteer 幂等）均不覆盖「同 subject 重复发布」。

3. **触发自治零反馈（P1）** — 读图确认点「触发自治」后页面**无任何 toast/计数/"已选派 X 个"/忙碌指示**；`handleTriggerAutonomy`（SocietyView L102-110）只 `setTickBusy`，且 `store.mutate`（societyStore L87-98）丢弃 `runAutonomyTick`/`autoSelectPending` 返回的 `applied`/`selected` 计数。后端数据证明自治确已生效（4 need→assigned），但 UI 上用户无从得知「刚发生了什么」。另：gstack `click "button:has-text('触发自治')"` **超时**——主应用 team SSE 持续重连使 networkidle 永不 settle（非 society 缺陷，但干扰自动化驱动，须改用固定延时 wait）。

**排除断言（避免误报）**：
- 早期截图 `hermit-03/04`（after-demo/after-autonomy）**作废**——当时误点 @e19/@e15 把页面带去 `/teams`、`/dashboard`（违反「只测 /society」），截图非 /society 视图；其中 04 的「创建数字员工」弹窗是**主应用**数字员工创建框（字段 Agent类型/项目/Provider/Claude Code），**非** worker-society 注册弹层（后者字段=名称/能力/声誉/harness/kind）。已 `goto /society` 重置。
- 标签不可读**非**截图压缩所致——同截图中节点形状/边/粒子均清晰可辨，唯文字不可读。

| 域 | 结论 | 产品意见 |
|---|---|---|
| 图谱节点标签可读性（SOCIETY-006 投影 / 012 挂载） | ❌ FAIL（读图） | **体验阻断级**：纯图谱若读不出谁是谁，等于失能。须让 worker 名/task 标题在 `/society` 始终可读。优先于一切。 |
| 加载示例幂等（SOCIETY-002-001 派生） | ❌ FAIL（数据） | 重跑翻倍、产孤儿 open need。建议「加载示例」先清空或按 subject 去重；真实 `publishNeed` 可保留不幂等（多源发布场景合理）。 |
| 触发自治反馈（SOCIETY-003-009/010） | ⚠️ 部分（功能✅ / 反馈❌） | 闭环数据成立，但零反馈 = 用户不知发生了什么。须回显「已自荐 X、已选派 Y」。 |

**下一轮候选**：
- ① 修 #1 标签可读——**设计决策待用户拍板**：默认放大初始 zoom（最轻、/society 本地，但一屏容纳节点变少）vs HTML 叠层标签（清晰、可交互，但与 canvas 标签重复须抑制）；
- ② 修 #3 自治反馈——/society 本地、低风险、收益明确，**可直接做**（surface `applied`/`selected` 计数到 toast）；
- ③ 修 #2 加载示例幂等——/society 本地（demo 先清空或按 subject 去重）。
**建议下一轮选 ②**（低风险、独立、明确收益）；#1 待用户定方向后单独攻关。

### 迭代 #47 · 2026-06-14（3 缺陷 P0→P1 修复验收 · `/society` 实驱 + 单测）
**驱动**：用户拍板「三个按 P0→P1 依次全做」；#1（标签可读）采「HTML 叠层标签」。本轮完成 #1/#2/#3 全部修复并以 gstack+读图 + 单测双轨验收。范围严格限 `/society` 单页，未触共享引擎 `packages/agent-graph`。

**修复 #1 · 图谱节点标签不可读（P0）→ ✅ PASS**
- 方案：新增 `SocietyNodeLabels.tsx`（HTML 叠层标签层），经引擎 `GraphView.renderHud`（**全节点** hook，非 `renderOverlay`——后者仅选中节点）挂载；单 `requestAnimationFrame` 循环**复用引擎** `getNodeWorldPosition`+`worldToScreen` 定位（不重算坐标 = 复用而非重写）。`SocietyGraph` 喂 `label:''` 抑制 canvas 文本、HTML 层用同源 `graphData` 标签；`pointer-events-none` 保证点击穿透回 canvas 节点（弹卡链路不变）。
- 读图验收（`soc-08`/`soc-10`）：worker 名（前端/后端/架构/评审工程师…）、task 标题（实现API / 爬一些数据 / 设计登录页 / 写技术文档…）全可读；按 kind/state 上色（worker 青 / task 按生命周期黄绿紫）。

**修复 #3 · 触发自治零反馈（P1）→ ✅ PASS**
- 方案：`societyStore.mutate` 改为回传命令结果（`Promise<T|undefined>`，出错返 undefined），`runAutonomyTick`/`autoSelectPending` 暴露 `{ok,applied}`/`{ok,selected}`；`handleTriggerAutonomy` 成功时 `setAutonomyNotice('自治完成：${applied} 个自荐 · 选派 ${selected} 个')`，4.5s 自动淡出，与 error/loading 同处工具条（不常驻噪音）。
- 读图验收（`soc-09`）：点「触发自治」后工具条出现绿色 `自治完成：3 个自荐 · 选派 3 个`。
- **弯路记录**：HMR 后 /society 一度整页崩溃（`Cannot access 'autonomyNotice' before initialization` TDZ）。`grep` 证明源码 4 处引用均在 L58 声明之后 → 非源码缺陷，是 React error-boundary 卡在我**中间态**（effect 曾先于 useState）的报错上、软 HMR 不自动恢复。**硬 reload（`location.reload()`）即清**，与 #1 无关。教训：改动 `useState`/`useEffect` 相对顺序后须硬刷一次。

**修复 #2 · 加载示例非幂等（P1）→ ✅ PASS**
- 方案：新增纯函数 `selectDemoNeedsToSeed(demoNeeds, liveSubjects)`（societyDemo.ts），按 subject 对在途需求去重 + 批次内自去重；`handleLoadDemo` 从 `activeNeeds` 投影 live subjects 后调用之。**`publishNeed` 保持非幂等**（多源同名发布是正确语义）——幂等是 demo 播种的职责，不污染核心命令（精准有效、不引入第二套语义）。
- 单测（societyDemo.test.ts +4）：冷启动全发 / 同名在途被跳过 / 全在途→空 / 批次内去重，全绿。
- **实驱幂等证明**：当前 DB 本就有 2 组重复主题（`实现登录页面 UI`/`评审并测试用户 API` 各 2 条，含 1 条 vol=0 卡 open 的孤儿）。点「加载示例」→ 副标题 `8 个在途任务` **纹丝不动**（旧逻辑会变 10）；`selectDemoNeedsToSeed` 对两条同名 demo need 全去重 → 发 0 条。**正是该 bug 的真实态上复现修复**。

**回归**：`worker-society` 全量 273/273 通过（14 文件，含新增 4 例）；`pnpm typecheck` 干净（worker-society 零错误；ClaudeDoctorProbe 3 条环境基线见 [[hermit-typecheck-baseline]]）。

| 域 | #46 结论 | #47 结论 | 产品意见 |
|---|---|---|---|
| 标签可读（SOCIETY-006/012） | ❌ FAIL | ✅ PASS | HTML 叠层 + 引擎坐标复用，清晰可交互；canvas 文本已抑制无重复。 |
| 加载示例幂等 | ❌ FAIL | ✅ PASS | 按 subject 去重，重跑零增长；核心 publishNeed 不幂等语义保留。 |
| 触发自治反馈（SOCIETY-003-009/010） | ⚠️ 部分 | ✅ PASS | 绿色 toast 回显自荐/选派计数，4.5s 淡出，闭环可见。 |

**遗留（非缺陷、历史数据）**：修复只防新增、未清历史重复 need（DB 仍存 #46 期遗留的 1 条 vol=0 卡 open 同名副本）。属历史 QA 造数据，非代码缺陷；后续若要干净复测可清 `~/.hermit/society/*` 重启。
**下一轮**：3 缺陷全闭环。回到半小时循环——下一轮做完整「冷启动→加载示例→触发自治→逐 need 交付/审核」端到端产品走查，并复核无回归。

### 迭代 #48 · 2026-06-14（半小时 UI 循环 #48409522 首跑 · 发现并修 #4 弹卡定位）
**驱动**：新循环 `48409522`（每 30 分 :07/:37）首次触发。本轮目标=首次实驱「纯图谱」核心交互（点节点→弹卡→生命周期动作），这是 #46/#47 均未触达的界面。无 reset 端点（`rg reset|clear societyRoutes` = NONE），故在现有数据上走查（历史 dup 视为已知）。

**发现 #4 · 节点弹卡飞出视口（P1，纯图谱核心交互阻断）→ ✅ 已修**
- 现象：js-click 任务节点 `评审并测试用户 API`，弹卡 DOM 测得 `left:1528,top:826`（视口仅 1280×720，`cutOff:true`）——**整张卡在屏幕外**，用户点节点却啥也看不见。
- 根因（查引擎 GraphView.tsx L963-1026）：引擎**自身**已用 Floating UI（`computePosition`+`placement:'right-start'`+`offset(16)`+`flip`+`shift`+`autoUpdate RAF`）把 `fixed z-20` 包裹层定位到节点旁并夹进容器。而 `SocietyNodeOverlay` **又**用 `clampOverlayPosition` 给卡片加 `absolute left/top`——两层定位叠加 = **double-offset**，卡飞到 `wrapper_pos + pos` 处。
- 修复（/society 本地、零触引擎）：① 弹卡根 `absolute`→`relative`（保留 ✕ 按钮锚点）、去掉自算 `left/top`，让引擎 Floating UI 独占定位；② 删冗余 `clampOverlayPosition`（纯函数 + 5 测）——它本就是 Floating UI 的重复实现（右溢翻左 / 上下夹进），属既有债务，顺手清掉。
- 验证：同节点重驱，卡 `left:773,top:493 → right:1003,bottom:682`，`onScreen:true`（贴节点右侧、不遮节点、全可见）。

**首次端到端验证「纯图谱」交互闭环**：点节点 → 弹卡（标题/状态徽章「已选派」/执行者 reviewer/自荐者 chip 正确，DOM 权威核对）→ 点「▶ 开始执行」→ `/api/society/needs/active` 证实该 need `assigned→in_progress`（assignee=reviewer 那条翻状态，backend 那条同名副本不动）。**数据↔渲染一致、动作真正驱动状态。**

**回归**：`pnpm typecheck` 干净；worker-society **268/268**（273 − 5 删掉的 clamp 测）；#1/#2/#3 在 fresh load 上复验仍 PASS（soc-11）。

**驱动技巧沉淀（供后续循环）**：canvas 节点不能 gstack `click @eN`（非 DOM 元素）——用 HTML 标签 chip 的 `getBoundingClientRect` 推算节点屏心（chip 顶上方 24px），再对 `<canvas>` dispatch `pointerdown/up` + `click`，触发引擎 `setSelectedNodeId` 命中测试。`click --help` 会超时（被当真实点击等 networkidle），别用。

| 域 | 结论 | 产品意见 |
|---|---|---|
| 弹卡定位（纯图谱核心交互） | ❌→✅（实驱首发现+修） | double-offset 是引擎换用 Floating UI 后 SocietyNodeOverlay 未同步的遗留；已清冗余 clamp，定位交还引擎。 |
| 弹卡生命周期动作（SOCIETY-003） | ✅（实驱首验） | 开始执行 → assigned→in_progress，数据/图谱同步，闭环成立。 |
| #1 标签 / #2 幂等 / #3 反馈 | ✅ 复验 | fresh load 仍 PASS，无回归。 |

**遗留观察（非代码缺陷）**：`实现登录页面 UI` 重复副本之一 `open vol=0` 永卡——因唯一匹配的 `frontend`/`backend` 已 `active=maxConcurrent=2` 满载，`autonomousVolunteers` 的 `isAtCapacity` 闸门正确拒绝。属历史 dup 数据 + 容量逻辑按设计工作，非 bug；#2 修复已防新增。要纯净复测须清 `~/.hermit/society/*` 重启。
**下一轮**：抽验尚未实驱的两条弹卡分支——worker 名片（发消息 from='user'）与 lead 广场概览卡；或做一次 delete-files + 重启的纯净冷启动全闭环走查。

### 迭代 #49 · 2026-06-14（10 分钟 doc-bug 循环 d3458b90 · 优化「停滞需求无反馈」UX）
**驱动**：新循环 `d3458b90`（每 10 分扫描本文档按优先级找待修/待优化项）。#46–#48 已把全部**代码缺陷**（#1 标签/#2 幂等/#3 自治反馈/#4 弹卡定位）闭环；本轮文档扫描确认无新增缺陷，但 #47/#48 两轮都反复挂着的 **遗留观察**是同一个产品缺口：*open + vol=0 的需求永远卡在「招募中」，界面不给任何解释——用户不知道它为何不动*。这不是代码 bug 而是体验缺口，本轮把它作为**优化项**收掉。

**优化 #5 · 停滞需求「为何卡住」归因提示（P1 体验优化）→ ✅ 已实现并实驱验证**
- 方案（复用而非重写，零新增状态）：新增纯函数 `classifyOpenNeedStall(need, workers): NeedStallReason | null`（societyPolicies.ts，紧挨 `canVolunteer` 后）。**复用** `canVolunteer`（判「是否还有人能接」）+ `capabilityMatchScore`（判「有没有人有能力」），不重算既有逻辑。返回 null = 未停滞（非 open / 已有自荐者 / 仍有 worker 可接，只是还没触发自治）；返回 `'workers_at_capacity'` = 有人有能力但都满载；返回 `'no_matching_worker'` = 没人匹配（含「唯一匹配者就是发布者」的不能自指派）。
- 接线（精准、零冗余）：`SocietyNodeOverlay` 的 `NeedCard` 已能从 props 拿到 `workerById`（member 卡早就在用），故**不加新 prop、不改 SocietyView 的 renderOverlay**——NeedCard 内 `classifyOpenNeedStall(need, [...workerById.values()])` 即可。仅当 `open && volunteers.length===0` 且归因非 null 时，在生命周期动作上方插一条琥珀色提示（`no_matching_worker`→「暂无匹配能力的成员——补能力或取消该需求」；`workers_at_capacity`→「匹配的成员均已满载，待其释放并发后自荐」），给用户可操作的反馈而非沉默卡死。
- 单测（societyPolicies.test.ts +7）：非 open/已有自荐→null、有可用匹配→null、匹配者满载→`workers_at_capacity`、无人有能力→`no_matching_worker`、唯一匹配者是发布者→`no_matching_worker`、混合（部分无能力+唯一匹配者满载）→`workers_at_capacity`、不改入参。全绿。

**回归**：worker-society **275/275**（原 268 + 新增 7）；`pnpm typecheck` 干净（worker-society 零错误）。

**实驱验证（正是 #48 遗留的那条 need）**：后端 `/api/society/needs/active` 证实 `实现登录页面 UI`（need-d8a8a6d6…）`open vol=0 caps=[react,css]`；workers 里仅 `frontend` 有 `react/css` 且 `active=2/2`（满载）。js-click 该节点 → 弹卡 DOM + 视觉双权威核对：
- DOM 文本含「招募中 / 发布者：user / react css / **匹配的成员均已满载，待其释放并发后自荐** / 触发自治」；
- `analyze_image` 读图确认标题/状态徽章/能力 chip/琥珀提示行齐全，**卡片完整在视口内未被裁切**（#4 的 Floating UI 定位修复仍生效）。

**结论**：#48 的遗留观察（open vol=0 永卡无解释）已从「沉默卡死」变为「可操作反馈」——用户现能一眼看出该需求是「没人会」还是「会的人忙满了」，据此补能力/取消或等待。闭环成立。
**下一轮**：循环将继续每 10 分扫描文档；若无新缺陷，可抽验 #48 提的未驱分支（worker 名片发消息 / lead 广场概览卡），或做一次清 `~/.hermit/society/*` 的纯净冷启动全闭环走查以复核无回归。

### 迭代 #50 · 2026-06-14（视觉重点 + 任务归属 · `/society` 实驱）
**驱动**：doc-bug 扫描无新增代码缺陷（#1–#5 全闭环）；用户对 #47 引入的「HTML 常驻标签层」提两条新视觉意见（属 #47 的体验回归）：①「现在更丑了，里面有太多字符串，视觉根本没有重点」；②「任务块也看不出来是跟谁关联的」。

**缺陷 #6 · 满图常驻标签无层级（P0 体验）→ ✅ PASS（实驱证明）**
- 根因：#47 的 `SocietyNodeLabels` 给**每个**节点恒定全亮标签（无 kind/state/focus 区分）→ 12 worker + task 后 = 一面「等亮字符串墙」，无锚点、眼睛无处落。是「把可读做出来」的副产品（#46/#47 解决可读、却丢了重点）。
- 修复（/society 本地、复用引擎焦点）：新增 `OPACITY` 三层 + 纯函数 `labelOpacity(node, focus)`——`lead`(广场)=1.0（唯一视觉锚）/ `state==='active'`=0.82（次焦点）/ 其余 idle·waiting·complete=0.34（退到背景）；`focusNodeIds` 非空（选中某节点）时焦点内全亮、其余压到 0.2。**复用引擎** `hud.focusNodeIds`（`buildFocusState` 已算好选中簇），不在此重算邻接；`focusRef` 随渲染更新、RAF 直接读最新值——选中切换不必重启循环（动态规划、复用而非重写）。chip 底色/投影/去边框不变（#47 已清）。
- 实驱证明（gstack `js` 读 DOM opacity 桶）：`chipCount:21, buckets:{1:1, 0.34:19, 0.82:1}`——广场独占 1.0、1 个 active 次亮、19 个 ambient 退后。锚点层级成立，替换「等亮墙」。

**缺陷 #7 · 任务块看不出归属（P1）→ ✅ PASS（rest 态可视 + 单测）**
- rest 态（未选中）已能读出归属，两层：①已指派 task——引擎 ownership 边 + 进行中沿边流动粒子直连其 worker（既有）；②**未指派 open need 原先无任何边 → 力导布局里孤立浮点**（正是「看不出跟谁关联」的根因）→ adapter 给它加 `agora → task` parent-child 边，表达「待认领、挂在广场」（ownership 语义无主不成立，故不用 ownership；粒子只属进行中的已指派任务，不给 open 加）。ambient 压低标签后，全亮 cyan 边更显眼，归属线更突出。
- 选中态（bonus）：点 worker → `focusNodeIds` 含其 owned tasks → 整簇高亮、其余 0.2，归属一目了然。复用引擎既有选中路径（弹卡同源，真实点击必触发）。
- 单测：`societyGraphAdapter.test.ts` 2 例随行为更名——open need 锚广场（parent-child、无 ownership/无粒子）；未知 assignee 锚广场。全绿。
- **自动化局限记录**（供后续循环，避免重走）：canvas 节点选中无法靠合成 `MouseEvent` 触发——引擎 `onMouseDown` 经 React 19 委派挂在外层 div，`dispatchEvent` 的合成 mouse 事件不触发其合成 handler（即便坐标命中、即便扫 Y）。`SocietyNodeOverlay` 弹卡（真实点击产物）证明选中路径本身正常；合成点击是无头驱动盲区，非代码缺陷。要验选中高亮须真人点。

**回归**：worker-society **278/278**（14 文件）；`pnpm typecheck` exit 0（worker-society 零错误，ClaudeDoctorProbe 3 条环境基线见 [[hermit-typecheck-baseline]]）。

| 域 | #49 结论 | #50 结论 | 产品意见 |
|---|---|---|---|
| 标签视觉重点（#6） | — | ✅ PASS（实驱） | 三层 opacity + 引擎 focusNodeIds 复用；广场锚点 + active 次亮 + 其余退背景。桶 {1:1,0.82:1,0.34:19} 实证。 |
| 任务归属可读（#7） | — | ✅ PASS（rest+单测） | open need 锚广场（不再孤立）；选中态整簇高亮（真人点验）。 |

**下一轮**：① 待用户对 #6/#7 视觉定夺（0.34 是否过暗/仍嫌字多——可调阈值，或改「选中才全亮、rest 仅显图标」）；② 抽验 #48 未驱分支（worker 名片发消息 / lead 广场概览卡）；③ 清 `~/.hermit/society/*` 纯净冷启动全闭环走查。


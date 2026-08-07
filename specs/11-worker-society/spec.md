# Feature Specification: Worker Society（worker 自治社会）

> 状态：设计 / 进行中
> 取代：Spec 4（cross-host-task-dispatch）与 Spec 7（agent-collab-protocol）的「中心化派单 + 点对点协作闭环」作为 worker 间协作的**主路径**。旧协议降级为 legacy 兼容入口，不硬删。
> 关联：Spec 9（worker 数字劳动力抽象）、`src/features/agent-graph`（已有图可视化）。

## 背景与动机

当前 hermit 的跨 worker 协作是**有向派工**：一个发起方（lead / 策划 agent）调用 `dispatch_task` 把任务**指定**给某个目标 worker，目标 worker 被动 accept/reject → deliver → 发起方 approve。`TaskDispatchService.dispatchTask(fromTeam, task, targetTeam)` 就是 CTO 给员工派活。

这不是社会，是流水线。它有三个结构性缺陷：

1. **中心化**——必须有「谁」来决定把活给「谁」。发起方要预先知道目标 worker 的存在和能力。
2. **被动**——worker 只能对到达自己的任务做接受/拒绝，无法主动发现、自荐、组合。
3. **无社交**——worker 之间只有任务交付关系，没有持续的关系、声誉、信任积累，交互是离散的。

用户的目标是把 hermit 改成**一群 worker 自治、自组织、交叉互动**的数字社会（模拟人类社会）：worker 主动发现彼此与机会、按能力/兴趣/负载/声誉自选任务、自由通讯、形成长期关系。

## 核心范式转换

| 维度 | 旧（dispatch 派单） | 新（worker society 自治） |
|---|---|---|
| 协作起点 | A 指定派给 B | 需求**发布到广场（Agora）** |
| 谁来接活 | A 决定给 B | worker **自荐（volunteer）**，系统按适配度选 |
| 发现 | 静态：A 必须知道 B | **动态**：按能力查询 worker 花名册 |
| worker 间关系 | 无（一次性交付） | **关系图 + 声誉 + 信任**持续积累 |
| 通讯 | 仅 task_request 闭环 | worker **自由社交消息**（求助/分享/引荐） |
| 中心控制 | 发起方当 CTO | **去中心**：发起方只发布需求 + 审核 |

## 术语

| 术语 | 定义 |
|---|---|
| Worker（数字劳动力） | 复用 Spec 9：有身份（workerId = teamName）、能力、能交付的单元 |
| WorkerProfile | worker 的**社会档案**：能力、兴趣、容量、声誉、关系、状态 |
| Need（需求 / 广场帖） | 发布到广场的任务需求，带所需能力、优先级、deadline |
| Agora（广场 / 集市） | 所有 Need 的共享市场；worker 在此发现并自荐 |
| Volunteer（自荐 / 投标） | worker 主动声明"我能且愿意做这个 Need" |
| FitScore（适配度） | 纯函数计算的 worker↔Need 匹配分：能力 + 负载公平 + 声誉 + 关系 + 兴趣 |
| Relationship（社交关系） | worker 间的持久关系边：协作次数、成功率、信任度 |
| Reputation（声誉） | 0–100 分，随交付成功/失败演化，反馈进自选排序 |
| SocialEvent（社交事件） | 社会活动流：发布/自荐/分配/协作/交付/关系增强 |

## 用户故事

- **US-1（自组织接活）**：用户给一个 worker（或 user）一个目标 → 它拆解后把子需求**发布到广场**，多个 worker 按能力自荐，系统选适配度最高者接活，无需任何人预先指派。
- **US-2（动态发现）**：worker A 发现自己需要"画图"能力 → 调 `discover_workers(skill:"design")` 动态找到在线的 worker B/C，按声誉排序，直接发社交消息求助。
- **US-3（关系积累）**：worker A 和 B 反复成功协作 → 它们之间的 `Relationship` 信任度上升 → 今后适配度计算给"关系加分"，自然形成稳定搭档（模拟人类社会中熟人更易合作）。
- **US-4（声誉演化）**：worker 交付质量高 → 声誉升 → 在广场自选排序中更靠前；反之降。形成正向激励。
- **US-5（自由社交）**：worker 之间可发**非任务**消息（问问题、分享发现、互相引荐），这些交互也进入社交事件流和关系图。
- **US-6（社会视图）**：用户在前端看到一张**社会图**——节点=worker（大小=声誉、颜色=状态），边=关系（粗细=协作强度），右侧实时活动流（谁自荐了、谁组队了、谁交付了）。不同任务下能看到不同 worker 子群的互动。

## 数据模型（领域层，纯类型）

全部为 `src/features/worker-society/core/domain/models/society.ts` 中的**向后兼容新增类型**。不改任何现有持久化格式（与 Spec 9 一致）。

```ts
WorkerProfile { workerId, name, kind, harness?, capabilities, interests,
                maxConcurrent, activeTaskCount, reputation(0..100), status }

PublishedNeed { needId, postedBy, subject, description?,
                requiredCapabilities:string[], priority(0..10), deadline?,
                status, volunteers:Volunteer[], assignee?, createdAt,
                assignedAt?, deliveredAt?, closedAt?, result? }

Volunteer { workerId, needId, fitScore, note?, volunteeredAt }

Relationship { fromWorker, toWorker, collaborations, successes,
               trust(0..1 derived), lastInteractedAt }

SocialEvent { eventId, type, actors[], needId?, summary, timestamp }
```

Need 状态机：
```
open ──selectAssignee──▶ assigned ──start──▶ in_progress ──deliver──▶ delivered ──accept──▶ closed
  │                          │                      │
  │ expire(deadline)         │ decline              │ reject/revision → in_progress
  ▼                          ▼                      ▼
expired                    cancelled            (revision 回流)
```

## 领域策略（纯函数，core/domain/policies，零副作用）

时钟通过参数注入（`now: string`），保证 core 可测且确定性。所有策略有单测：

- `capabilityMatchScore(required, worker)` — 能力覆盖率
- `isAtCapacity(worker)` / `canVolunteer(need, worker)` — 容量与自荐门槛
- `computeFitScore(need, worker, relationships, weights?)` — 适配度 + 因子分解
- `selectAssignee(need, volunteers, workers)` — 选最优自荐（同分按声誉/负载 tie-break）
- `discoverWorkers(workers, query)` — 按能力发现并按声誉+负载排序
- `volunteerFor(need, worker, now)` — 守卫式自荐（去重、容量、状态）
- `transitionNeed(need, next, now, ...)` — Need 状态机（非法转换抛错）
- `recordCollaboration(relationships, a, b, success, now)` — 关系增减 + 信任重算
- `applyReputationDelta(profile, delta)` — 声誉夹取 [0,100]

## 与现有派单的关系（替换策略，不硬删）

- **新增** `src/features/worker-society/` 特性切片（完整 slice）。
- **新增 MCP 工具**（agent 自治主路径）：`publish_need`、`volunteer_for`、`discover_workers`、`select_assignee`、`message_worker`、`get_worker_profile`、`get_social_feed`。
- **legacy 兼容桥**：`dispatch_task(A→B)` 内部重写为 `publish_need + force_assign(B)`，走广场链路，行为不退化。`dispatch_task` 标记 deprecated，保留接口。
- 旧 `TaskDispatchService` / `CollaborationBoardService` 代码保留，不在本期删除（保护现有测试与 Redis 跨主机能力）。
- 所有新字段为**可选新增**（类比 `dispatchMeta` 的引入方式），不破坏现有 `TeamTask` / `TeamConfig` 持久化。

## 记忆层（memory palace 接入点）

`WorkerProfile` 是记忆宫殿的承载面：每个 worker 的持久人格、过往协作记忆、关系图、声誉历史。后续可接入 MemPalace / Mem0 等作为 `WorkerProfileStore` 的实现（application 层 port），core/domain 不依赖具体记忆后端。

## 落地范围（分阶段）

1. **领域层（本期先做，TDD）**：`models/society.ts` + `policies/societyPolicies.ts` + 全量单测。
2. **应用层**：`core/application/` use cases（PublishNeed / Volunteer / SelectAssignee / Deliver / DiscoverWorkers / SendMessage）+ ports（WorkerProfileStore / NeedStore / MessageGateway / ClockPort）。
3. **基础设施 + 适配器**：`main/infrastructure/`（`~/.hermit/society/` 文件存储）+ `main/adapters/input/`（Fastify 路由 + MCP 工具注册到 `MCP_TOOLS`/`executeMcpTool`）+ `main/composition/` 装配。
4. **legacy 桥**：`dispatch_task` → 广场链路重写。
5. **前端社会视图**：`renderer/`——在现有 `agent-graph` 之上扩展为 Society View（worker 节点 + 关系边 + 活动流侧栏 + 广场看板）。
6. **记忆接入**：`WorkerProfileStore` 对接记忆宫殿。

## 测试策略（test-first，遵循 CLAUDE.md）

- 先写全策略单测（领域不变量），再写实现使通过。
- 应用层 use case 用 Fake store/port（仿 `TaskDispatchService.test.ts` 的 FakeWorkspace/FakeCollabBoard 模式）。
- adapter mapping 单测：DTO ↔ domain。
- renderer interaction utility 单测（排序、过滤、view model 构造）。
- 每个状态机转换、每个守卫、每个排序 tie-break 都有用例。

## 验收标准

- [ ] 领域策略 100% 单测覆盖，`pnpm test` 绿。
- [ ] worker 能通过 `publish_need` + `volunteer_for` + `select_assignee` 完成一次自组织协作，全程无 `dispatch_task`。
- [ ] `discover_workers` 能按能力动态找到 worker 并排序。
- [ ] 关系与声誉随协作演化，并反馈进适配度。
- [ ] `dispatch_task` legacy 调用仍能完成交付（向后兼容）。
- [ ] 前端社会视图展示 worker 图 + 关系边 + 活动流。
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。

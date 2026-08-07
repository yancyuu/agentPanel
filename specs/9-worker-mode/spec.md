# Spec 9 — Worker Mode（数字劳动力）

## 背景与动机

Hermit 当前的核心抽象是「团队（Team）」。但产品方向已收敛为：**Hermit 是一个本地的数字劳动力操作系统**，每一个可被调度、有身份、能交付的单元都是一个 **Worker（数字劳动力）**。

关键洞察：**「团队」本身就已经是一个 Worker**。`teamName` 天然就是 Worker 的身份标识（workerId）。因此本规格**不引入任何新的身份字段**，而是：

1. 在概念上把「团队」提升为「数字劳动力」，并把团队详情页头部做成一张**数字劳动力身份证（员工工牌）**；
2. 定义一个统一的 **Worker 抽象**，让「Hermit 团队（composite worker）」与「外部单能力服务（atomic worker，如 Micro-Sniper）」用同一种契约被发现和调度。

> 非目标（Non-Goals）：本期不重命名磁盘目录 / 配置 schema 中的 `team*` 字段（保持向后兼容），不实现外部 atomic worker 的运行时托管，不替换现有 cross-team dispatch 协议。

## 术语

| 术语 | 定义 |
|---|---|
| Worker（数字劳动力） | 有身份、有能力、可被指派、能交付的单元 |
| workerId | Worker 的稳定身份。**等于 `teamName`**，不新增字段 |
| composite worker | 由多个 agent 组成的 Hermit 团队 |
| atomic worker | 单一能力的外部服务（实现 Worker 契约的 HTTP 端点） |
| Worker 契约 | atomic worker 要被 Hermit 发现/调度需实现的最小接口 |

## 用户故事

- US-1：作为用户，我打开一个团队详情页时，看到的是一张「数字劳动力身份证」——头像、姓名、工号（=teamName）、角色、在岗状态、能力、任务履历，一眼就知道「这是谁、会什么、现在能不能干活、干过多少活」。
- US-2：作为用户，我能把一个外部服务（如 Micro-Sniper）登记为 atomic worker，它和团队一样出现在花名册里，带能力清单和在线状态。
- US-3：作为团队 lead（agent），我能把一个长任务派给一个 atomic worker，**立即拿到 task_id 返回**（不阻塞），稍后通过状态查询/通知拿到结果。

## 功能需求

### FR-1 数字劳动力身份证（员工工牌 UI）— 本期交付

- 复用 `TeamViewSnapshot` 已有数据，**零后端改动**：
  - 身份：`teamName`（工号）、`config.name`（姓名）、`config.description`（角色）、`harness`
  - 头像：`agentAvatarUrl(teamName)`（已有确定性头像）
  - 状态：`isAlive` → 在岗 / provisioning → 启动中 / 否则 离线
  - 能力：`members[].role` 去重
  - 履历：`tasks` 中 `completed` / `in_progress` 计数、成员数
  - 配色：沿用 `getTeamColorSet` / `nameColorSet` 的 accent
- 组件：`src/renderer/components/team/WorkerIdCard.tsx`，员工工牌视觉（挂绳缺口、头像、状态灯、能力 chips、履历条）。
- 接入：替换 `TeamDetailView` 头部的 `h2 + 状态徽章`，保留编辑/更多按钮与项目路径/分支行。

### FR-2 Worker 抽象类型（类型层，向后兼容）

新增 `src/shared/types/worker.ts`：

```ts
export type WorkerKind = 'composite' | 'atomic';

export interface WorkerIdentity {
  workerId: string;        // = teamName（composite）或服务自报 id（atomic）
  name: string;
  kind: WorkerKind;
  harness?: string;        // 'claude' | 'codex' | 'micro-sniper' | ...
}

export interface WorkerCapability {   // 复用现有 AgentCapability 形状
  skill: string;
  description: string;
}

export interface DiscoverableWorker extends WorkerIdentity {
  location: 'local' | 'remote';
  status: 'online' | 'offline';
  capabilities?: WorkerCapability[];
  description?: string;
}
```

- `DiscoverableTeam`（已存在）即 `DiscoverableWorker` 的 composite 特例；提供从 `DiscoverableTeam` → `DiscoverableWorker` 的适配函数，不破坏现有调用方。

### FR-3 Worker 契约（atomic worker 实现，Micro-Sniper 落地于 Spec/仓库 B）

atomic worker 暴露 4 个 HTTP 端点即可进入花名册并被调度：

| 端点 | 作用 |
|---|---|
| `GET /worker/identity` | 返回 `WorkerIdentity{ workerId, name, kind:'atomic', harness }` |
| `GET /worker/capabilities` | 返回 `WorkerCapability[]` |
| `POST /worker/dispatch` | 收任务，**异步立即返回** `{ taskId }` |
| `GET /worker/tasks/:taskId` | 返回 `{ status, result? }`，状态复用 `DispatchStatus` |

- 关键约束：`dispatch` **不得阻塞**等待长任务完成（爬取等分钟级任务），fire-and-forget + 轮询/回填。

## 数据与契约约束

- **不新增** `workerId` 字段到 `TeamConfig`；`teamName` 即 workerId。
- 类型层新增向后兼容，不改动现有持久化文件格式。
- 复用现有 `AgentCapability` / `DispatchStatus`。

## 验收标准

- [x] 打开任一团队详情页，头部呈现员工工牌（头像/工号/状态/能力/履历）。
- [x] 单人团队显示「N 成员」与角色；多人团队聚合成员角色为能力 chips。
- [ ] `worker.ts` 类型与 `DiscoverableTeam→DiscoverableWorker` 适配通过 typecheck。
- [ ] atomic worker（Micro-Sniper）实现 4 端点并能被 `GET /worker/identity` 探活。
- [ ] `pnpm typecheck` 通过。

## 落地范围（本期）

1. ✅ `WorkerIdCard.tsx` + 接入 `TeamDetailView`（FR-1）。
2. ⏳ `shared/types/worker.ts` + 适配函数（FR-2）。
3. ⏳ Micro-Sniper 实现 Worker 契约（FR-3，见 Micro-Sniper 仓库 `specs/2-worker-contract/`）。

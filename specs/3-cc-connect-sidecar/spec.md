# Feature Spec: cc-connect Sidecar Architecture

## Summary

将 Hermit 完全重构为"团队管理 + cc-connect 适配"两层结构：

1. **cc-connect 作为 sidecar**：所有 AI Agent 的启动/停止/会话/消息/Provider/模型/心跳由 cc-connect Management API 负责，Hermit 不再 spawn 任何本地 CLI 子进程。
2. **Hermit 作为团队适配层**：负责团队的 CRUD、成员编排、任务/看板/Review/Skills 等团队级功能，并把这些操作翻译成 cc-connect API 调用。
3. **团队 = 独立工作目录**：每个团队对应一个磁盘上的根目录，团队的元数据、任务、消息历史、成员 workspace 都收敛在该目录下。Hermit 同时支持两种来源：
   - **托管模式**：根目录由 Hermit 在 `~/.hermit/teams/<team-slug>/` 下自动创建。
   - **绑定模式**：用户在创建团队时指定一个已有的本地 Git 仓库路径作为团队根目录，成员 work_dir 落在该仓库或其 worktree 中。

重构边界采用"按 sidecar 重新评估"原则：所有现存功能（任务看板、Code Review、Extensions/Skills/MCP、消息历史、成员配置等）都需要逐项判断是保留、改写以适配 cc-connect、还是直接删除，结果以 FR-5 的"功能去留清单"形式给出。

## Background & Motivation

当前 Hermit 的 `TeamProvisioningService`（24000+ 行）直接管理 Agent CLI 子进程：spawn、进程表扫描、PID 监控、stdin/stdout 流解析、环境变量注入等。这带来了以下问题：

- **复杂度极高**：仅 team services 目录就有 72000+ 行代码，大量与进程管理、运行时检测相关
- **重复造轮子**：cc-connect 已经完整实现了 Agent CLI 的生命周期管理、provider 管理、会话管理、心跳监控
- **可维护性差**：支持新 Agent 类型需要在 Hermit 中新增大量 runtime adapter 代码
- **部署限制**：本地进程管理要求 Hermit 和 Agent 在同一台机器上

cc-connect 作为 sidecar 运行在 `localhost:9820`，已具备完整的 Agent 管理能力：
- 支持 10+ 种 Agent CLI（Claude Code、Codex、Gemini、Qoder、OpenCode、Cursor、Kimi、ACP 等）
- 完善的 provider/model 管理
- 会话持久化 + 心跳监控
- WebSocket Bridge 实时事件
- Bot-to-Bot Relay 跨 agent 通信

重构后 Hermit 专注于自己的核心价值：**团队编排和管理 UI**，大幅降低代码量（预计删除 40000+ 行）。

## User Scenarios

### Primary: 团队启动与管理

1. 用户在 Hermit UI 创建一个团队，配置 Lead + 3 个 Member
2. 点击"启动团队"，Hermit 通过 cc-connect API 为每个成员创建对应的 project
3. cc-connect 自动启动对应 CLI 进程（Claude Code / Codex / Gemini 等）
4. 用户在 Hermit 看到团队成员状态实时更新（在线/离线/忙碌）
5. 用户发消息给某个成员，消息通过 cc-connect 送达，回复实时显示在 Hermit UI

### Primary: 团队作为独立工作目录

1. 用户创建团队时选择"托管模式"，Hermit 在 `~/.hermit/teams/<team-slug>/` 下自动创建根目录，并在其中初始化团队配置、任务、消息历史等子目录
2. 或用户选择"绑定模式"，指定一个已有本地 Git 仓库路径作为团队根目录；Hermit 在该仓库的 `.hermit/` 子目录下保存团队元数据，不污染主代码树
3. 启动团队时，每个成员的 cc-connect project `work_dir` 由该团队根目录派生（同一目录或其 worktree/子目录），保证团队与其文件资产 1:1 对应
4. 在 UI 中按"团队"维度浏览：团队列表、团队下的成员、团队内的任务/消息/Review 全部隔离
5. 删除团队时，Hermit 询问是仅清理映射与元数据，还是连同托管目录一起删除；绑定模式下永远不删除用户原仓库

### Secondary: Provider 与模型管理

1. 用户在 Settings 中配置 cc-connect 地址和 token
2. 创建团队时，Provider 列表和模型列表从 cc-connect 动态获取
3. 用户可选择任何 cc-connect 中已配置的 Provider，无需在 Hermit 中重复配置

### Tertiary: 团队协作（跨 Agent 通信）

1. 一个团队中的 Lead Agent 需要将子任务委派给 Member Agent
2. Hermit 通过 cc-connect relay API 在 agents 之间路由消息
3. Member 完成任务后，结果通过 relay 回传给 Lead

### Edge: cc-connect 不可用

1. cc-connect sidecar 未启动或网络不可达
2. Hermit UI 显示连接状态警告
3. 用户仍可浏览已有的团队数据、任务看板、Review 等离线数据
4. Agent 相关操作（启动/发消息）被禁用并显示原因

## Functional Requirements

### FR-1: cc-connect 连接管理

- **FR-1.1**: 支持配置 cc-connect 地址（默认 `http://127.0.0.1:9820`）和认证 token
- **FR-1.2**: 实时监测 cc-connect 可用性（通过 `GET /api/v1/status`）
- **FR-1.3**: 连接断开时在 UI 显示警告，恢复后自动重连
- **FR-1.4**: 支持通过环境变量 `CC_CONNECT_BASE_URL` 和 `CC_CONNECT_TOKEN` 配置

### FR-2: Team → cc-connect Project 映射

- **FR-2.1**: 每个 Hermit team member 映射为一个 cc-connect project
- **FR-2.2**: 团队启动时，为每个成员创建 cc-connect project（配置 agent_type、work_dir、provider）
- **FR-2.3**: 团队停止时，停止/删除对应的 cc-connect projects
- **FR-2.4**: 维护 team member ↔ cc-connect project name 的映射关系（持久化）
- **FR-2.5**: 支持查询成员运行状态（通过 cc-connect heartbeat/status API）

### FR-2A: 团队工作目录

- **FR-2A.1**: 创建团队时必须确定团队根目录，且支持以下两种模式：
  - **托管模式**：默认在 `~/.hermit/teams/<team-slug>/` 下创建，由 Hermit 完全管理
  - **绑定模式**：用户指定一个已有本地目录（通常是 Git 仓库），Hermit 在其下使用 `.hermit/` 子目录存放团队元数据
- **FR-2A.2**: `team-slug` 由团队名生成，必须是文件系统安全的 ASCII（中文团队名需要单独 slug 化），并保证全局唯一；如冲突则追加数字后缀
- **FR-2A.3**: 团队根目录下的标准布局至少包含：`config.json`（团队配置）、`members/`（成员配置）、`tasks/`（任务数据）、`messages/`（消息历史/inbox）、`mappings.json`（cc-connect project 映射），具体子目录可在实现阶段细化
- **FR-2A.4**: 成员 `work_dir` 必须从团队根目录派生：默认 `<team-root>/members/<member-slug>/`，绑定模式下也可由用户改为指向仓库本身或 worktree 路径
- **FR-2A.5**: 列出团队时按团队根目录分组：每个团队包含成员、任务、消息、Review 全部独立
- **FR-2A.6**: 删除团队提供两种粒度：
  - 仅断开 cc-connect projects 与移除 Hermit 内的映射/元数据
  - 在托管模式下额外允许删除整个团队根目录；绑定模式下永远不删除用户原目录
- **FR-2A.7**: 重命名团队不改变现有根目录路径，仅更新展示名称，避免破坏 cc-connect project 引用与 Git 仓库现有 commit
- **FR-2A.8**: 启动团队前，Hermit 必须校验团队根目录存在、可写；绑定模式额外提示用户是否为期望的 Git 仓库

### FR-3: 消息通路

- **FR-3.1**: 发消息给 Agent 通过 `POST /api/v1/projects/{name}/send`
- **FR-3.2**: 接收 Agent 输出通过 cc-connect Bridge WebSocket 或 session history 轮询
- **FR-3.3**: 实时消息流传给前端（通过现有 SSE 机制）
- **FR-3.4**: 支持团队内跨 Agent 消息路由（通过 cc-connect relay）

### FR-4: Provider/模型管理

- **FR-4.1**: Provider 列表从 cc-connect `/api/v1/providers` 获取
- **FR-4.2**: 模型列表从 cc-connect `/api/v1/providers/presets` 或 `/api/v1/projects/{name}/models` 获取
- **FR-4.3**: 创建团队时可选择任何已配置的 Provider
- **FR-4.4**: 删除 Hermit 本地的 CLI 安装检测 / provider status 轮询逻辑

### FR-5: 现存功能去留清单（按 sidecar 重新评估）

每项功能必须落到三类之一：**保留 (Keep)** / **改写 (Rewrite)** / **删除 (Drop)**。

#### FR-5.1 必须保留 (Keep) — Hermit 核心价值

- **FR-5.1.1**: 团队 CRUD（创建/编辑/删除/恢复），含名称、描述、成员配置
- **FR-5.1.2**: 任务管理（创建/分配/状态/看板），任务数据存团队根目录下
- **FR-5.1.3**: Code Review 流程（review 决策、apply、ledger）
- **FR-5.1.4**: 团队成员配置（角色/权限/模型偏好）
- **FR-5.1.5**: 消息历史与活动时间线（包含跨 agent 协作记录）
- **FR-5.1.6**: 团队模板源（Git 仓库同步）
- **FR-5.1.7**: Skills 多源（Git 仓库同步）

#### FR-5.2 改写以适配 sidecar (Rewrite)

- **FR-5.2.1**: Agent 启动/停止 → 调用 cc-connect API（不再 spawn 本地进程）
- **FR-5.2.2**: 消息发送 → cc-connect `POST /projects/{name}/send`；消息接收 → Bridge WS
- **FR-5.2.3**: 成员状态/心跳 → cc-connect `heartbeat` API（替代 PID 监控）
- **FR-5.2.4**: Provider 列表与模型列表 → cc-connect `/providers` 与 `/projects/{name}/models`
- **FR-5.2.5**: MCP 配置：保留 Hermit 端 UI，但下发到 cc-connect project 配置而非本地 CLI 启动参数
- **FR-5.2.6**: Extensions/Skills 注入：通过 cc-connect project 的 `work_dir` 与 prompt 注入，不再依赖本地 CLI 包装
- **FR-5.2.7**: 团队工作目录管理 (FR-2A) — 新增能力，整合原 worktree manager 的部分职责

#### FR-5.3 删除 (Drop) — 由 cc-connect 负责或不再需要

- **FR-5.3.1**: 本地 CLI 子进程管理（spawn/kill、stdin/stdout 解析）
- **FR-5.3.2**: 进程健康检查与 PID/RSS 监控
- **FR-5.3.3**: 进程表扫描（POSIX/Windows）
- **FR-5.3.4**: Runtime adapters（opencode/、runtime/、stallMonitor/）
- **FR-5.3.5**: CLI 二进制解析与 doctor 探测（ClaudeBinaryResolver、ClaudeDoctorProbe）
- **FR-5.3.6**: 本地 runtime profile features（anthropic-runtime-profile、codex-runtime-profile、team-runtime-lanes）
- **FR-5.3.7**: 本地 CLI 安装检测、provider runtime status 轮询
- **FR-5.3.8**: 本地 provider 凭据管理（如已迁移到 cc-connect 的部分）

#### FR-5.4 待定 (Undecided) — 实现阶段再评估

下列功能在 plan 阶段必须给出明确结论：

- 跨团队消息（CrossTeamService、CrossTeamOutbox）：是否仍由 Hermit 路由，或借助 cc-connect relay
- 自动恢复/Reconcile（AutoResumeService、TeamReconcileDrainScheduler）：sidecar 模式下是否仍需要
- 任务 worker（TaskChangeWorker、TeamFsWorker）：是否合并到主进程或完全删除

### FR-6: cc-connect 不可用时的降级行为

- **FR-6.1**: cc-connect 离线时，Hermit UI 必须仍能浏览所有团队、任务、消息历史、Review 数据（只读）
- **FR-6.2**: 写操作（启动/停止团队、发送消息、创建 project）被禁用并显示明确原因
- **FR-6.3**: 连接恢复后所有写操作自动恢复，不需要用户重启 Hermit

## Non-Functional Requirements

- **NFR-1**: 重构后 team services 总代码量不超过 15000 行（当前 72000+）
- **NFR-2**: cc-connect API 调用超时上限 15 秒，带重试
- **NFR-3**: 团队启动到所有成员就绪的时间不超过 cc-connect 启动 project 的时间 + 5 秒 overhead
- **NFR-4**: 无 cc-connect 时，只读操作正常工作（团队列表、任务查看、历史消息）

## Success Criteria

- 用户可以通过 Hermit UI 启动/停止团队，Agent 由 cc-connect 管理
- 用户在 Hermit 中发送消息，Agent 正确接收并回复
- 用户创建团队时可从 cc-connect 获取的 Provider/Model 列表中选择
- 团队成员状态（在线/离线）实时准确反映 cc-connect 中的 project 状态
- 用户可以创建托管模式与绑定模式两种团队，团队列表按团队根目录隔离展示
- 删除托管团队时根目录被清理，删除绑定团队时用户原仓库不受影响
- Hermit 主进程不再 spawn 任何 Agent CLI 子进程（可通过 ps/Activity Monitor 验证）
- cc-connect 离线时 Hermit 仍可浏览团队列表、任务、历史消息（只读）
- 团队适配层（`src/main/services/team/` 与 `src/features/`）经过去留清单评估后没有遗留死代码或仅供旧执行层使用的工具
- FR-5 中标记为 "Drop" 的所有功能在最终代码库中不存在

## Key Entities

### Team ↔ cc-connect Project 映射

| Hermit Entity | cc-connect Entity | 关系 | 备注 |
| ------------- | ----------------- | ---- | ---- |
| Team | Project Group (逻辑) | 1:N | 一个 Team 拥有一个 TeamWorkspaceRoot |
| Team Member (Lead) | Project (agent_type=claudecode) | 1:1 | work_dir 派生自团队根目录 |
| Team Member (Worker) | Project (agent_type=codex/gemini/opencode/qoder) | 1:1 | work_dir 派生自团队根目录 |
| Message | Session message | 1:1 | 历史持久化在团队根目录 |
| Provider | Global Provider | N:1 | 完全由 cc-connect 管理 |

### TeamWorkspaceRoot

每个团队对应的磁盘根目录元数据。

- `teamSlug`: string（文件系统安全的唯一 slug）
- `displayName`: string（用户可见名称，支持中文）
- `mode`: `"managed"` | `"bound"`
- `rootPath`: absolute path
  - 托管模式：`~/.hermit/teams/<team-slug>/`
  - 绑定模式：用户指定的本地目录
- `metadataDir`: absolute path
  - 托管模式：`<rootPath>`
  - 绑定模式：`<rootPath>/.hermit/`
- `gitRepo`: boolean（绑定模式下是否检测到 `.git`）
- `createdAt`: ISO8601

### CcConnectProjectMapping

- `teamSlug`: string
- `memberSlug`: string
- `ccProjectName`: string（cc-connect 中的 project name，命名规则 `hermit-<teamSlug>-<memberSlug>`）
- `agentType`: AgentType
- `workDir`: string（默认 `<TeamWorkspaceRoot.rootPath>/members/<memberSlug>/`，绑定模式可由用户改写）
- `createdAt`: ISO8601

## Assumptions

- cc-connect sidecar 始终与 Hermit 运行在同一台机器上（localhost 通信）
- cc-connect 已配置好所需的 Agent CLI（Claude Code、Codex 等已安装）
- cc-connect 的 Management API token 由用户预先配置
- Hermit 的团队管理数据（任务、看板、消息历史）随团队根目录存储；不再使用全局 `~/.hermit/teams.json` 风格的单一文件
- cc-connect 的 project 命名可由 Hermit 控制（用于建立映射）
- cc-connect 的 project `work_dir` 也由 Hermit 控制，cc-connect 不会自行修改
- Bridge WebSocket 是获取实时 Agent 输出的主要方式
- 团队名支持中文，但内部 `team-slug`、`member-slug` 是 ASCII 安全 slug，遵循 README/CLAUDE.md 既有约定
- 用户在绑定模式下指定的目录拥有读写权限；权限不足时拒绝创建团队

## Out of Scope

- cc-connect 自身的部署和配置管理（用户自行处理）
- cc-connect 的 Web UI（Hermit 不嵌入/替代 cc-connect 的管理界面）
- 跨机器部署（Hermit 和 cc-connect 分开部署在不同机器）
- Agent CLI 的安装/更新管理（由 cc-connect 负责）
- 聊天平台集成（飞书/Telegram 等仍由 cc-connect 直接处理）
- 在绑定模式下接管用户的 Git 操作（commit/push/pull 仍由用户/Agent 自行完成）
- 历史团队数据从旧版 Hermit 自动迁移到新的"团队=文件夹"布局（必要时单独提供一次性迁移脚本，不在本 feature 范围）
- 多用户并发编辑同一团队根目录的协调（同一时刻假定只有单 Hermit 实例操作目录）

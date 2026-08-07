# Implementation Plan: cc-connect Sidecar Architecture

## Technical Context

| Area | Current State | Target |
|------|--------------|--------|
| Agent Execution | 24000 行 TeamProvisioningService 直接 spawn CLI | ~1000 行 cc-connect API 编排器 |
| Provider/Model | 本地 CLI probe + CliProviderStatus | cc-connect /api/v1/providers |
| 消息通路 | 文件 inbox 读写 | cc-connect /api/v1/projects/{name}/send + Bridge WS |
| 进程监控 | PID 扫描 + processHealth | cc-connect heartbeat API |
| Runtime Adapters | opencode/, runtime/, stallMonitor/ (~12000 行) | 删除 |
| cc-connect 集成 | 仅 proxy 层 (ccConnectProxy.ts) | 完整 client + bridge |

## Architecture Decision: cc-connect as Execution Backend

Hermit team 操作映射到 cc-connect API：

```
Hermit (Team Management UI)
  │
  ├── TeamProvisioningService (重写)
  │     └── CcConnectClient → http://localhost:9820/api/v1/*
  │
  ├── CcConnectBridge (新增)
  │     └── WebSocket → ws://localhost:9810/bridge/ws
  │     └── 转换为 SSE 事件推送给前端
  │
  └── Team Data (保留)
        ├── TeamDataService (团队配置/元数据)
        ├── TeamTaskReader / KanbanManager
        ├── ReviewApplierService
        └── Extensions / Skills / MCP
```

### cc-connect Project 创建流程

```
POST /api/v1/{project-name}/add-platform
  body: { type: "bridge", options: {}, work_dir: "/path", agent_type: "claudecode" }
  → config.toml 写入新 [[projects]] 块
  → Response: { "restart_required": true }

POST /api/v1/restart
  → cc-connect 重启，新 project engine 启动
```

### Bridge WebSocket 集成

Hermit 通过 Bridge WebSocket (`ws://localhost:9810/bridge/ws`) 注册为一个 platform adapter：
- 发送 `register` 消息声明 capabilities: `["text", "buttons", "card", "typing", "preview"]`
- 接收 agent 输出（`reply`, `reply_stream`, `card`, `buttons` 等）
- 发送用户消息（`message` 类型）

### 概念映射细化

| 操作 | cc-connect API |
|------|---------------|
| 创建 project | `POST /api/v1/{name}/add-platform` + `POST /api/v1/restart` |
| 配置 project | `PATCH /api/v1/projects/{name}` (work_dir, mode, agent_type) |
| 删除 project | `DELETE /api/v1/projects/{name}` + `POST /api/v1/restart` |
| 发送消息 | `POST /api/v1/projects/{name}/send` (需 session_key) |
| 查看会话 | `GET /api/v1/projects/{name}/sessions` |
| 查看历史 | `GET /api/v1/projects/{name}/sessions/{id}?history_limit=50` |
| 心跳检查 | `GET /api/v1/projects/{name}/heartbeat` |
| Provider 列表 | `GET /api/v1/providers` |
| 模型列表 | `GET /api/v1/projects/{name}/models` |
| 跨 agent 通信 | relay (Unix socket API, 或 Bridge WS 转发) |

## Implementation Phases

### Phase 1: CcConnectClient 服务层 (Est: 3-4 hours)

**Goal**: 建立与 cc-connect 通信的基础设施

#### 1.1 CcConnectClient
File: `src/main/services/ccConnect/CcConnectClient.ts` (新建)

封装 cc-connect Management API 调用：
- `getStatus()` → GET /api/v1/status
- `listProjects()` → GET /api/v1/projects
- `getProject(name)` → GET /api/v1/projects/{name}
- `createProject(name, agentType, workDir)` → POST /api/v1/{name}/add-platform + restart
- `updateProject(name, settings)` → PATCH /api/v1/projects/{name}
- `deleteProject(name)` → DELETE /api/v1/projects/{name} + restart
- `sendMessage(projectName, sessionKey, message)` → POST /api/v1/projects/{name}/send
- `listSessions(projectName)` → GET /api/v1/projects/{name}/sessions
- `getSession(projectName, sessionId, historyLimit?)` → GET /api/v1/projects/{name}/sessions/{id}
- `getHeartbeat(projectName)` → GET /api/v1/projects/{name}/heartbeat
- `listProviders()` → GET /api/v1/providers
- `listModels(projectName)` → GET /api/v1/projects/{name}/models
- `getProviderPresets()` → GET /api/v1/providers/presets
- `restart()` → POST /api/v1/restart

#### 1.2 CcConnectBridge (WebSocket 桥接)
File: `src/main/services/ccConnect/CcConnectBridge.ts` (新建)

- 连接 Bridge WebSocket (`ws://localhost:9810/bridge/ws`)
- 发送 `register` 消息
- 接收 `reply` / `reply_stream` / `card` / `buttons` 事件
- 转换为 Hermit SSE 事件 broadcast

#### 1.3 类型定义
File: `src/shared/types/ccConnect.ts` (新建)

cc-connect API 请求/响应完整 TypeScript 类型。

#### 1.4 配置集成
File: `src/main/services/infrastructure/ConfigManager.ts` (修改)

增加 cc-connect 配置项：
- `ccConnect.baseUrl` (默认 `http://127.0.0.1:9820`)
- `ccConnect.bridgeUrl` (默认 `ws://127.0.0.1:9810/bridge/ws`)
- `ccConnect.token` (默认从 env `CC_CONNECT_TOKEN`)

---

### Phase 2: TeamProvisioningService 重写 (Est: 6-8 hours)

**Goal**: 用 cc-connect API 替代本地 CLI 进程管理

#### 2.1 新的 TeamProvisioningService
File: `src/main/services/team/TeamProvisioningService.ts` (重写)

核心方法：
- `launchTeam(teamName, members[])`:
  1. 为每个 member 调用 `ccClient.createProject()`
  2. 配置 agent_type, work_dir, provider
  3. 等待 cc-connect restart
  4. 通过 Bridge WS 确认 project 启动
  5. 发送初始 prompt
- `stopTeam(teamName)`:
  1. 为每个 member 调用 `ccClient.deleteProject()`
  2. 触发 restart
- `getTeamStatus(teamName)`:
  1. 遍历 member 对应的 cc-connect projects
  2. 查询 heartbeat/session status
- `sendMessage(teamName, memberName, message)`:
  1. 查找 member 对应的 cc-connect project
  2. 获取活跃 session_key
  3. 调用 `ccClient.sendMessage()`

#### 2.2 ProjectMappingStore
File: `src/main/services/ccConnect/ProjectMappingStore.ts` (新建)

持久化 team member ↔ cc-connect project name 映射：
- `getProjectName(teamName, memberName): string | null`
- `setMapping(teamName, memberName, ccProjectName, agentType, workDir)`
- `removeMapping(teamName, memberName)`
- `getTeamProjects(teamName): MappingEntry[]`

存储位置：`~/.hermit/cc-connect-mappings.json`

#### 2.3 消息桥接
File: `src/main/services/ccConnect/MessageBridge.ts` (新建)

- 从 CcConnectBridge 接收的 agent 输出 → 路由到对应的 team member
- 格式转换：cc-connect message format → Hermit team message format
- 触发 SSE 事件 `team-change` / `provisioning-progress`

---

### Phase 3: 删除本地 Agent 执行层 (Est: 4-5 hours)

**Goal**: 移除不再需要的 ~40000 行代码

#### 3.1 删除文件列表

**src/main/services/team/opencode/** (整个目录):
- bridge/, capabilities/, config/, delivery/, events/, mcp/, permissions/, readiness/, store/, version/

**src/main/services/team/runtime/** (整个目录):
- OpenCodeTeamRuntimeAdapter.ts, TeamRuntimeAdapter.ts, index.ts

**src/main/services/team/stallMonitor/** (整个目录)

**src/main/services/team/ 单文件**:
- ClaudeBinaryResolver.ts
- ClaudeDoctorProbe.ts
- TeamRuntimeLivenessResolver.ts
- TeamMemberWorktreeManager.ts
- TeamBootstrapStateReader.ts
- TeamLaunchStateEvaluator.ts
- TeamLaunchStateStore.ts
- AutoResumeService.ts
- TeamReconcileDrainScheduler.ts
- TeamMemberRuntimeAdvisoryService.ts

**src/main/utils/**:
- childProcess.ts
- processHealth.ts
- processKill.ts
- processRss.ts
- posixProcessTable.ts
- windowsProcessTable.ts
- shellEnv.ts

**src/main/services/runtime/**:
- providerAwareCliEnv.ts
- ProviderConnectionService.ts
- providerModelProbe.ts
- providerRuntimeEnv.ts
- geminiRuntimeAuth.ts

**src/features/**:
- anthropic-runtime-profile/ (整个目录)
- codex-runtime-profile/ (整个目录)
- team-runtime-lanes/ (整个目录)

#### 3.2 清理 import 和引用

更新所有引用被删除模块的文件，确保编译通过。

#### 3.3 删除相关测试

删除 `test/` 目录中对应的测试文件。

---

### Phase 4: Provider/Model UI 重写 (Est: 3-4 hours)

**Goal**: 从 cc-connect 获取 provider/model 数据

#### 4.1 删除本地 Provider 检测
Files to remove/simplify:
- `src/renderer/utils/claudeCodeOnlyProviders.ts` (删除)
- `src/renderer/hooks/useEffectiveCliProviderStatus.ts` (重写为 cc-connect)
- `src/renderer/utils/teamModelAvailability.ts` (简化)
- `src/shared/types/cliInstaller.ts` (删除大部分)

#### 4.2 新的 Provider Hook
File: `src/renderer/hooks/useCcConnectProviders.ts` (新建)

- 从 cc-connect `/api/v1/providers` 获取 provider 列表
- 从 `/api/v1/providers/presets` 获取预设
- 缓存 + 轮询刷新

#### 4.3 重写 TeamModelSelector
File: `src/renderer/components/team/dialogs/TeamModelSelector.tsx` (重写)

- Provider tabs 从 cc-connect providers 动态生成（不再硬编码 4 个）
- Model 列表从 cc-connect provider presets / models API 获取
- 删除所有 CLI runtime status 检测逻辑

#### 4.4 简化 httpClient.ts
File: `src/renderer/api/httpClient.ts` (修改)

- 删除所有 `CliInstaller` 相关方法
- 删除 `RuntimeProviderManagement` 相关方法
- 删除 `Codex Account` 相关方法
- Provider/Model 方法改为调 cc-connect proxy

---

### Phase 5: standalone.ts 精简 + 集成测试 (Est: 3-4 hours)

**Goal**: 精简入口，确保端到端工作

#### 5.1 精简 standalone.ts
File: `src/main/standalone.ts` (重写)

- 删除不再需要的服务初始化（runtime adapters, CLI resolver 等）
- 添加 CcConnectClient + CcConnectBridge 初始化
- 启动时检查 cc-connect 可用性

#### 5.2 更新 HTTP 路由
File: `src/main/http/teams.ts` (修改)

- launch/stop 路由改为调用新的 TeamProvisioningService（走 cc-connect）
- 消息发送路由改为 cc-connect send API
- 状态查询改为 cc-connect project status

#### 5.3 前端连接状态
File: `src/renderer/components/settings/sections/AdvancedSection.tsx` (修改)

- 添加 cc-connect 连接状态显示
- 配置 cc-connect URL/Token 的 UI

#### 5.4 集成验证

验证流程：
1. 启动 cc-connect (`localhost:9820`)
2. 启动 Hermit standalone
3. 在 UI 中创建团队 → 验证 cc-connect 中创建了对应 projects
4. 发送消息 → 验证 agent 收到并回复
5. 停止团队 → 验证 cc-connect projects 被清理

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `src/main/services/ccConnect/CcConnectClient.ts` | 新建 (~400行) | 1 |
| `src/main/services/ccConnect/CcConnectBridge.ts` | 新建 (~300行) | 1 |
| `src/main/services/ccConnect/ProjectMappingStore.ts` | 新建 (~150行) | 2 |
| `src/main/services/ccConnect/MessageBridge.ts` | 新建 (~200行) | 2 |
| `src/shared/types/ccConnect.ts` | 新建 (~200行) | 1 |
| `src/main/services/team/TeamProvisioningService.ts` | 重写 (24000→~1000行) | 2 |
| `src/main/services/team/opencode/` | 删除 (~8000行) | 3 |
| `src/main/services/team/runtime/` | 删除 (~2000行) | 3 |
| `src/main/services/team/stallMonitor/` | 删除 (~1500行) | 3 |
| `src/main/services/team/{10+ files}` | 删除 (~5000行) | 3 |
| `src/main/utils/{7 files}` | 删除 (~2000行) | 3 |
| `src/main/services/runtime/` | 删除 (~1000行) | 3 |
| `src/features/{3 dirs}` | 删除 (~1800行) | 3 |
| `src/renderer/utils/claudeCodeOnlyProviders.ts` | 删除 | 4 |
| `src/renderer/hooks/useCcConnectProviders.ts` | 新建 (~100行) | 4 |
| `src/renderer/components/team/dialogs/TeamModelSelector.tsx` | 重写 (560→~200行) | 4 |
| `src/renderer/api/httpClient.ts` | 简化 (2130→~800行) | 4 |
| `src/main/standalone.ts` | 重写 (400→~200行) | 5 |
| `src/main/http/teams.ts` | 修改 | 5 |
| Settings UI | 修改 | 5 |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| cc-connect restart 时 agent 中断 | cc-connect 的 restart 是 exec-replace，project engine 会自动重新连接 |
| Bridge WS 连接不稳定 | 自动重连 + 消息序列号去重 |
| Session key 未知 | 创建 project 后通过 Bridge WS 注册，使用 `bridge:hermit-{teamName}:{memberName}` 格式 |
| 大量删除导致编译失败 | Phase 3 分批删除，每批后验证编译 |
| cc-connect 不可用时 UI 体验差 | 保留所有只读操作（团队列表、任务、历史），仅禁用写操作 |

## Estimated Timeline

| Phase | Hours | Dependencies |
|-------|-------|-------------|
| Phase 1: CcConnectClient 服务层 | 3-4h | None |
| Phase 2: TeamProvisioningService 重写 | 6-8h | Phase 1 |
| Phase 3: 删除本地执行层 | 4-5h | Phase 2 |
| Phase 4: Provider/Model UI 重写 | 3-4h | Phase 1 |
| Phase 5: standalone 精简 + 集成 | 3-4h | Phase 2-4 |
| **Total** | **19-25h** | |

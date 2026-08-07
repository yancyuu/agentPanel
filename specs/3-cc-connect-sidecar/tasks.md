# Tasks: cc-connect Sidecar Architecture

## Phase 1: CcConnectClient 服务层

### Task 1.1: 创建 cc-connect TypeScript 类型定义
- **File**: `src/shared/types/ccConnect.ts` (新建)
- **Action**: 定义 cc-connect Management API 的完整请求/响应类型
- **包含**: CcProjectInfo, CcSessionInfo, CcMessage, CcHeartbeatStatus, CcProviderInfo, CcStatus, CcProjectSettings 等
- **依赖**: 无

### Task 1.2: 实现 CcConnectClient
- **File**: `src/main/services/ccConnect/CcConnectClient.ts` (新建)
- **Action**: 封装所有 cc-connect Management API 调用
- **方法**: getStatus, listProjects, getProject, createProject (add-platform + restart), updateProject, deleteProject, sendMessage, listSessions, getSession, getHeartbeat, listProviders, listModels, getProviderPresets, restart
- **依赖**: Task 1.1

### Task 1.3: 实现 CcConnectBridge (WebSocket)
- **File**: `src/main/services/ccConnect/CcConnectBridge.ts` (新建)
- **Action**: Bridge WebSocket 客户端，注册为 hermit platform adapter
- **功能**: 自动连接/重连, register 握手, 接收 reply/reply_stream/card/buttons, 发送 message, 事件 emitter
- **依赖**: Task 1.1

### Task 1.4: 配置集成
- **File**: `src/main/services/infrastructure/ConfigManager.ts` (修改)
- **Action**: 增加 ccConnect.baseUrl, ccConnect.bridgeUrl, ccConnect.token 配置项
- **同时**: 更新 `src/shared/types/` 中的配置类型
- **依赖**: 无

---

## Phase 2: TeamProvisioningService 重写

### Task 2.1: 创建 ProjectMappingStore
- **File**: `src/main/services/ccConnect/ProjectMappingStore.ts` (新建)
- **Action**: team member ↔ cc-connect project name 映射的持久化存储
- **方法**: getProjectName, setMapping, removeMapping, getTeamProjects, getAllMappings
- **存储**: `~/.hermit/cc-connect-mappings.json`
- **依赖**: 无

### Task 2.2: 创建 MessageBridge
- **File**: `src/main/services/ccConnect/MessageBridge.ts` (新建)
- **Action**: 从 CcConnectBridge 接收 agent 输出 → 路由到对应 team member → 触发 SSE 事件
- **功能**: session_key 解析, 消息格式转换, team-change 事件 broadcast
- **依赖**: Task 1.3, Task 2.1

### Task 2.3: 重写 TeamProvisioningService
- **File**: `src/main/services/team/TeamProvisioningService.ts` (重写)
- **Action**: 24000 行 → ~1000 行。核心方法：
  - `launchTeam`: 为每个 member 创建 cc-connect project → restart → 发初始 prompt
  - `stopTeam`: 删除 cc-connect projects → restart
  - `getTeamStatus`: 查询 cc-connect project heartbeat/status
  - `sendMessage`: 通过 cc-connect send API 发送
  - `getMemberSessions`: 通过 cc-connect sessions API 查询
- **依赖**: Task 1.2, Task 2.1, Task 2.2

### Task 2.4: 更新 team index.ts 导出
- **File**: `src/main/services/team/index.ts` (修改)
- **Action**: 更新导出，反映新的 TeamProvisioningService API
- **依赖**: Task 2.3

---

## Phase 3: 删除本地 Agent 执行层

### Task 3.1: 删除 opencode/ 目录
- **路径**: `src/main/services/team/opencode/` (整个目录)
- **Action**: 删除所有 opencode runtime 相关代码
- **依赖**: Task 2.3

### Task 3.2: 删除 runtime/ 目录
- **路径**: `src/main/services/team/runtime/` (整个目录)
- **同时**: `src/main/services/runtime/` (providerAwareCliEnv, ProviderConnectionService, providerModelProbe, providerRuntimeEnv, geminiRuntimeAuth)
- **依赖**: Task 2.3

### Task 3.3: 删除 stallMonitor/ 目录
- **路径**: `src/main/services/team/stallMonitor/` (整个目录)
- **依赖**: Task 2.3

### Task 3.4: 删除进程管理工具
- **文件列表**:
  - `src/main/utils/childProcess.ts`
  - `src/main/utils/processHealth.ts`
  - `src/main/utils/processKill.ts`
  - `src/main/utils/processRss.ts`
  - `src/main/utils/posixProcessTable.ts`
  - `src/main/utils/windowsProcessTable.ts`
  - `src/main/utils/shellEnv.ts`
- **依赖**: Task 2.3

### Task 3.5: 删除 CLI 相关文件
- **文件列表**:
  - `src/main/services/team/ClaudeBinaryResolver.ts`
  - `src/main/services/team/ClaudeDoctorProbe.ts`
  - `src/main/services/team/TeamRuntimeLivenessResolver.ts`
  - `src/main/services/team/TeamMemberWorktreeManager.ts`
  - `src/main/services/team/TeamBootstrapStateReader.ts`
  - `src/main/services/team/TeamLaunchStateEvaluator.ts`
  - `src/main/services/team/TeamLaunchStateStore.ts`
  - `src/main/services/team/AutoResumeService.ts`
  - `src/main/services/team/TeamReconcileDrainScheduler.ts`
  - `src/main/services/team/TeamMemberRuntimeAdvisoryService.ts`
- **依赖**: Task 2.3

### Task 3.6: 删除 runtime profile features
- **路径**:
  - `src/features/anthropic-runtime-profile/` (整个目录)
  - `src/features/codex-runtime-profile/` (整个目录)
  - `src/features/team-runtime-lanes/` (整个目录)
- **依赖**: Task 2.3

### Task 3.7: 清理 import 引用 + 编译验证
- **Action**: 修复所有因删除导致的 import 错误，确保 `pnpm build` 通过
- **依赖**: Task 3.1-3.6

### Task 3.8: 删除相关测试文件
- **Action**: 删除 `test/` 目录中对应已删除模块的测试
- **依赖**: Task 3.7

---

## Phase 4: Provider/Model UI 重写

### Task 4.1: 创建 useCcConnectProviders hook
- **File**: `src/renderer/hooks/useCcConnectProviders.ts` (新建)
- **Action**: 从 cc-connect API 获取 provider 列表和模型 presets
- **依赖**: Phase 1

### Task 4.2: 重写 TeamModelSelector
- **File**: `src/renderer/components/team/dialogs/TeamModelSelector.tsx` (重写)
- **Action**: Provider tabs 动态生成，模型列表从 cc-connect 获取，删除 CLI status 检测
- **依赖**: Task 4.1

### Task 4.3: 删除/简化本地 Provider 逻辑
- **文件列表**:
  - `src/renderer/utils/claudeCodeOnlyProviders.ts` (删除)
  - `src/renderer/hooks/useEffectiveCliProviderStatus.ts` (删除或重写)
  - `src/renderer/utils/teamModelAvailability.ts` (简化)
  - `src/renderer/components/team/dialogs/providerPrepareDiagnostics.ts` (删除)
  - `src/renderer/components/team/dialogs/memberModelScope.ts` (简化)
  - `src/renderer/utils/memberLaunchDiagnostics.ts` (简化)
- **依赖**: Task 4.1, Task 4.2

### Task 4.4: 简化 httpClient.ts
- **File**: `src/renderer/api/httpClient.ts` (修改)
- **Action**: 删除 CliInstaller, RuntimeProviderManagement, CodexAccount 相关方法，Provider/Model 方法改为 cc-connect proxy
- **依赖**: Task 4.1

---

## Phase 5: 集成与精简

### Task 5.1: 精简 standalone.ts
- **File**: `src/main/standalone.ts` (重写)
- **Action**: 删除不需要的服务初始化，添加 CcConnectClient + CcConnectBridge 初始化
- **依赖**: Phase 2, Phase 3

### Task 5.2: 更新 HTTP 路由 (teams.ts)
- **File**: `src/main/http/teams.ts` (修改)
- **Action**: launch/stop/send-message 路由改为调用新的 TeamProvisioningService
- **依赖**: Task 2.3, Task 5.1

### Task 5.3: 前端 cc-connect 状态 UI
- **File**: `src/renderer/components/settings/sections/AdvancedSection.tsx` (修改)
- **Action**: 添加 cc-connect 连接状态显示和配置 UI
- **依赖**: Task 1.4

### Task 5.4: 端到端集成验证
- **Action**: 验证完整流程：创建团队 → 启动 → 发消息 → 收到回复 → 停止
- **依赖**: All previous tasks

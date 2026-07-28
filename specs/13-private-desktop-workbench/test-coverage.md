<!-- markdownlint-disable MD013 -->

# Server 拆分前测试覆盖盘点（Phase 0）

> 本文只描述基线与补测要求，不代表 Phase 0 已退出。**硬门禁不变：server split、类型检查、server build、聚焦回归及生命周期验证完成前，不得开始 Electron 工作。**

## 盘点结论

- 现有测试主要覆盖 service、renderer state/UI 和 client URL 组装；未发现直接对 `src/main/server.ts` 创建 Fastify 实例并使用 `app.inject()`/`fastify.inject()` 的 route contract 测试。
- 因而现有测试能保护部分领域语义，但不能证明 235 个 route 的注册、Fastify 匹配优先级、HTTP status/body/content-type、全局 Origin hook、fallback 或插件封装行为。
- Phase 0 应先建立可注入的 server factory/test harness，再按下表补齐最小关键 contract；不要为了易测而同时改产品语义。

## 现有测试到 route domain 的映射

| Route domain                      | 现有测试文件（代表性）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 已覆盖的相邻行为                                                                                     | 拆分前必须补齐的 baseline gap                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| teams / tasks / messages / review | `src/main/services/team-management/TeamWorkspaceService.test.ts`；`test/features/team-management/TeamProvisioningService.test.ts`；`test/features/team-management/TeamWorkspaceService.test.ts`；`test/main/utils/teamProjectResolution.test.ts`；`src/renderer/utils/__tests__/teamMessageKey.test.ts`；`src/renderer/utils/__tests__/mergeTeamMessages.test.ts`；`src/renderer/utils/__tests__/teamMessageFiltering.test.ts`；`test/renderer/api/httpClient.exactTaskLogs.test.ts`；`test/renderer/api/httpClient.teamRuntimeFallback.test.ts`；`test/renderer/utils/taskReferenceUtils.test.ts`；`test/shared/utils/taskChangeState.test.ts` | workspace read/write、provisioning、项目解析、renderer 消息去重/过滤、TaskRef 和部分 client fallback | 用 `inject()` 锁定团队/任务 CRUD、message ID、`isMeta`、TaskRef、soft-delete/restore、review/status/owner 映射和错误码；逐项证明静态 `/api/teams/tasks`、`runtime/alive`、`provisioning/*`、`templates`、`config`、`review/*` 不落入 `:name`；验证消息先持久化后 SSE 广播。                                              |
| bridge / direct-cli               | `src/main/services/ccConnect/CcConnectBridge.test.ts`；`src/main/services/ccConnect/CcConnectLauncher.test.ts`；`src/main/services/ccConnect/workDirReconcile.test.ts`；`src/main/services/hermitBridge/__tests__/CcConnectBinaryFetcher.test.ts`；`src/main/services/direct-cli/DirectCliSessionManager.test.ts`；`src/main/services/direct-cli/DirectCliSessionStore.test.ts`；`src/main/services/direct-cli/__tests__/directCliMessageId.test.ts`；`src/main/utils/externalPlatformSessionKey.test.ts`                                                                                                                                       | bridge/launcher、workdir reconcile、direct-cli session/message ID、外部平台 key                      | 补代理 path/token/body/status/content-type 和非 JSON upstream error；证明 `/api/v1/system/readiness` 不被 `ALL /api/v1/*` 吞掉；覆盖 terminal resume、process-send、send-message、permission respond、direct-cli complete 复用 streaming messageId、bridge 外部平台路由及落盘后广播。                                    |
| setup / digital-worker            | `test/renderer/components/team/dialogs/PlatformSetupQR.test.tsx`；`src/renderer/components/team/dialogs/__tests__/CreateTeamDialog.bindProject.test.tsx`；`src/renderer/components/team/dialogs/__tests__/CreateTeamDialog.chineseRepro.test.tsx`；`src/renderer/services/__tests__/createTeamPreferences.test.ts`；`src/main/telemetry/larkCredentials.test.ts`；`src/main/telemetry/worker.larkCredentials.test.ts`                                                                                                                                                                                                                           | setup UI、团队创建输入、lark credential 解析/上报                                                    | 对 Feishu/Weixin begin/poll/save 与 add-platform 建立 HTTP contract；覆盖缺字段、取消/过期、save、restart rejection 的稳定响应；证明 Feishu 使用个人 `as user`/完整 domain，非 Feishu 不触发授权。不得把 lark credential reporting 与 usage telemetry 混删。                                                             |
| editor security                   | `test/renderer/store/editorSlice.test.ts`；`test/renderer/hooks/useEditorKeyboardShortcuts.test.ts`；`test/renderer/components/team/editor/EditorSelectionMenu.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | renderer editor 状态和交互                                                                           | 当前没有 main route 路径安全基线。覆盖 read/write/create/delete/move/rename/list/search/binary preview 的允许根、`..`、绝对路径、编码绕过、symlink 逃逸、源/目标双向校验、类型错误；watch routes 还需验证清理和隔离。                                                                                                    |
| extensions                        | `test/renderer/components/extensions/ExtensionStoreView.test.ts`；`test/renderer/components/extensions/mcp/CustomMcpServerDialog.test.ts`；`test/renderer/components/extensions/skills/SkillEditorDialog.test.ts`；`test/renderer/hooks/useExtensionsTabState.test.ts`；`test/renderer/store/extensionsSlice.test.ts`；`test/shared/utils/extensionNormalizers.test.ts`；`test/shared/utils/providerExtensionCapabilities.test.ts`；`src/renderer/components/extensions/capability-packs/CapabilityPackDetailDialog.test.tsx`                                                                                                                   | renderer flows、normalization、capability display                                                    | 为 plugins/MCP/library/capability-packs/skills/credentials 增加注册及最小 success/error contract；验证 download headers/zip、缺失 projectPath/folderName、watch start/stop、`skills:changed` SSE；local source/emitter 每进程只装配一次。                                                                                |
| telemetry / task-bus              | `src/main/services/session-intelligence/__tests__/UsageTelemetryService.test.ts`；`src/main/services/session-intelligence/__tests__/ConversationMessageUploadService.test.ts`；`src/main/services/session-intelligence/__tests__/AiMonitorUsageClient.test.ts`；`test/main/telemetry/usageTelemetryAutostart.test.ts`；`test/main/telemetry/usageTelemetryWorkerStatus.test.ts`；`src/main/telemetry/__tests__/workerSingleton.test.ts`；`src/main/telemetry/worker.scheduler.test.ts`；`src/renderer/components/settings/sections/TaskBusSection.test.tsx`                                                                                     | telemetry service/worker、调度、部分设置 UI                                                          | 锁定 `/api/telemetry/{scan,export,conversations*,status}` 和 `/api/settings/task-bus` 当前 status/body/error；验证 singleton/PID 状态不因插件加载重复初始化。Phase 0 只隔离；后续删除 usage 时单独改断言，并保留 lark credentials reporting。                                                                            |
| startup / shutdown / static / SSE | `src/main/services/ccConnect/CcConnectLauncher.test.ts`；`test/main/telemetry/usageTelemetryAutostart.test.ts`；`src/main/telemetry/__tests__/workerSingleton.test.ts`；`src/main/services/session-intelligence/__tests__/ImLiveWatcher.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                | 个别 launcher、telemetry autostart/singleton、IM watcher                                             | factory 无 import-time `listen()`；同一 context 只有一份 bridge/watcher/direct-cli/SSE maps；覆盖 startup 顺序和 shutdown 的 watcher stop、direct-cli shutdown、launcher stop、bridge dispose、bounded `app.close()`；验证 SIGINT/SIGTERM/exit、`/api/events`、SSE/API/SPA fallback、static-last 和无 build 时 `/` 503。 |

## 建议的最小 baseline 测试分层

1. **Route manifest test**：从组装后的 Fastify app 探测 route，断言总数与方法统计为 235，并保存 method/path 快照。
2. **Router precedence test**：专测 `/api/v1/system/readiness` vs `/api/v1/*`，以及所有 `/api/teams/<static>` vs `:name` 冲突点。
3. **Domain contract tests**：每个高风险域用 fake context + `app.inject()` 覆盖最小成功、校验失败、依赖失败。
4. **Lifecycle test**：对 context factory、server factory、standalone start、shutdown 分层测试，证明实例数和清理顺序。
5. **Fallback/SSE test**：独立验证 unknown API、SSE fallback、SPA/static，避免插件 encapsulation 改变 not-found scope。

## 聚焦验证命令

现有相邻基线：

```bash
pnpm vitest run \
  src/main/services/team-management/TeamWorkspaceService.test.ts \
  test/features/team-management/TeamProvisioningService.test.ts \
  src/main/services/ccConnect/CcConnectBridge.test.ts \
  src/main/services/direct-cli/DirectCliSessionManager.test.ts \
  src/main/services/direct-cli/__tests__/directCliMessageId.test.ts \
  src/main/services/session-intelligence/__tests__/UsageTelemetryService.test.ts \
  test/main/telemetry/usageTelemetryAutostart.test.ts \
  test/main/telemetry/usageTelemetryWorkerStatus.test.ts \
  test/renderer/store/editorSlice.test.ts \
  test/renderer/components/extensions/ExtensionStoreView.test.ts
```

新增 route baseline 后（建议目标文件名）：

```bash
pnpm vitest run \
  test/main/server/routeManifest.test.ts \
  test/main/server/routerPrecedence.test.ts \
  test/main/server/teamsRoutes.test.ts \
  test/main/server/bridgeRoutes.test.ts \
  test/main/server/setupRoutes.test.ts \
  test/main/server/editorRoutes.security.test.ts \
  test/main/server/extensionsRoutes.test.ts \
  test/main/server/telemetryRoutes.test.ts \
  test/main/server/lifecycle.test.ts \
  test/main/server/fallbacks.test.ts
```

每次提取后的结构门禁：

```bash
pnpm typecheck 2>&1 | tail -20
pnpm build:server 2>&1 | tail -20
```

最终 Phase 0 还应执行维护者指定的完整回归集；聚焦命令不能替代完整验收。

## 退出判断

- 上述 gap 未补齐前，现有 service/UI 测试不是 server route extraction 的充分保护。
- 只有 route 数量/优先级、关键 contract、single-context 生命周期、SSE/static/fallback、类型检查与 server build 全通过，才可完成 Phase 0。
- **此前不得创建或修改 Electron main/preload/package，也不得提前迁移 renderer 或收缩 CLI。**

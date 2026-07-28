<!-- markdownlint-disable MD013 -->

# Server Context 与生命周期盘点（Phase 0）

> 本文记录 `src/main/server.ts` 当前由模块顶层隐式拥有的共享实例、内存状态、事件监听器和启动/关闭顺序。Phase 0 只显式化所有权并保持行为，不顺手修改产品语义。

当前已落地的 ownership seam：

- `serverContext.ts`：construction-only `ServerContext`、`ServerRuntimeState` 和 lifecycle bookkeeping；
- `serverEventHandlers.ts`：direct-cli/bridge listeners 的单点注册与精确 disposer；
- `serverStartup.ts`：standalone startup 编排；
- `serverProcessLifecycle.ts`：process signals 和有界 shutdown；
- Fastify `app` 在任何 background bridge work 与 listener wiring 之前构造。

Phase 0 已完成：`workbenchServer.ts` 提供无 listen 副作用的 route factory，`serverStandalone.ts` 独占进程启动与 signal handlers，context dispose 为幂等 promise，并清理 telemetry、SSE response、listener、direct CLI、launcher 和 bridge。生产 standalone composition 通过进程级 `getOrCreateStandaloneServerComposition()` 复用；测试和嵌入场景仍可显式创建隔离 composition。

## 顶层有状态实例

| 拟议 context 字段         | 当前符号                        |              `server.ts` 行 | 持有资源或依赖                                                          | 当前生命周期 API                      |
| ------------------------- | ------------------------------- | --------------------------: | ----------------------------------------------------------------------- | ------------------------------------- |
| `bridgeClient`            | `cc`                            |                         484 | cc-connect Management API 配置与请求                                    | 无显式 dispose                        |
| `bridgeConnection`        | `bridge`                        |                         489 | WebSocket、重连 timer、ping interval、EventEmitter listeners            | `start()`、`reconnect()`、`dispose()` |
| `bridgeLauncher`          | `bridgeLauncher`                |                         495 | 由本进程启动的 cc-connect child process                                 | `ensureRunning()`、`stop()`           |
| `teamProvisioning`        | `svc`                           |                         496 | 团队、任务、消息和 workspace；依赖 `cc` 与 `bridge`                     | 无显式 dispose                        |
| `systemManagerConfig`     | `systemManagerConfig`           |                         499 | System Manager 本地配置                                                 | 无显式 dispose                        |
| `workflowPrompt`          | `workflowPromptService`         |                         500 | workflow prompt 文件访问                                                | 无显式 dispose                        |
| `conversationTelemetry`   | `conversationTelemetry`         |                         635 | 会话缓存；callback 闭包依赖 `cc`、`svc`                                 | 无显式 dispose                        |
| `localSessionScanner`     | `localSessionScanner`           |                         641 | 本地 session 扫描                                                       | 无显式 dispose                        |
| `loopAssetsScanner`       | `loopAssetsScanner`             |                         642 | Loop assets 扫描                                                        | 无显式 dispose                        |
| `directCli`               | `directCliManager`              |                        1166 | CLI child processes、spawn promises、stream listeners                   | `shutdown()`                          |
| `imLiveWatcher`           | `imLiveWatcher`                 |                        1170 | FSWatcher、watchdog interval、debounce timer、cache、scan promise       | `start()`、`stop()`                   |
| `ccSettings`              | `hermitCcSettings`              |                        1174 | cc settings 文件访问                                                    | 无显式 dispose                        |
| `fastify`                 | `app`                           |                        1496 | HTTP listener、routes、hooks、SSE/raw sockets                           | `listen()`、`close()`                 |
| `dashboardRecentProjects` | `dashboardRecentProjectsLoader` |                        1501 | recent-project loader 闭包和缓存                                        | 无显式 dispose                        |
| `update`                  | `updateService`                 |                        3831 | 更新检查与执行状态                                                      | 无显式 dispose                        |
| `extensions`              | `ext`                           | extensions composition 区域 | plugin/MCP/capability pack/skill/credential services 与 watcher/emitter | 按内部 service 分散                   |

## 共享 Map、Set 与可变状态

| 拟议字段                       | 当前符号        | `server.ts` 行 | 语义与清理风险                                            |
| ------------------------------ | --------------- | -------------: | --------------------------------------------------------- |
| `runtimeConfig`                | `runtimeConfig` |            482 | 可变进程配置；client/routes 必须观察同一代配置            |
| `systemManagerEnsurePromise`   | 同名            |            511 | 并发 ensure 去重；`finally` 后清空                        |
| `teamStatsCache`               | 同名            |            644 | workdir TTL cache；过期 key 不主动清理                    |
| `sseClients`                   | 同名            |           1140 | 持有 live `ServerResponse`；shutdown 需主动 end/clear     |
| `directCliRoutes`              | 同名            |           1194 | sessionKey 到 inbox/reply route；child exit 后可能残留    |
| `toolApprovalSettingsByName`   | 同名            |           1199 | team 级审批设置缓存                                       |
| `permissionSessionByRequestId` | 同名            |           1210 | 待审批 request；缺少 timeout/child-exit/shutdown 清理     |
| `bridgeSessionTeamCache`       | 同名            |           1379 | 外部 sessionKey 到 team TTL cache；过期 key 不主动清理    |
| `allowedOriginSet`             | 同名            |           1526 | CORS/Origin 只读 lookup set                               |
| `scheduleRunsById`             | 同名            |           4047 | 每个 schedule 最多 100 runs，但 schedule key 数无全局上限 |
| `scheduleRunLogsByKey`         | 同名            |           4048 | 依赖显式 schedule state clear 清理                        |

Usage telemetry 保留既有进程级 singleton 语义：collector、scan interval、last scan 和 runtime status 仍为模块状态，但 collector 已改为首次扫描/显式配置时惰性创建，import 不再构造扫描器；standalone shutdown 显式停止 interval。后续删除 usage telemetry 时仍需单独修改行为和测试。

## 长生命周期监听器

`serverEventHandlers.ts` 集中注册 direct-cli 与 bridge 的 `event` / `reply` / `reply_stream` / `message` listeners，并把精确 disposer 保存到 context lifecycle；同一 context 的 `createWorkbenchServer()` 由 WeakMap 去重，不会重复注册。

`unhandledRejection`、`SIGINT`、`SIGTERM` 与 `exit` handlers 只由 `serverStandalone.ts` 安装，并通过返回的 remover 清理；可复用 factory 不接触 process handlers。

## 请求级资源

`GET /api/events` 为每个 SSE request 创建：

- 一条 `sseClients` 记录；
- 一个 15 秒 keepalive interval；
- 一个 `request.raw.close` 清理回调。

正常断连路径成对清理，但 server shutdown 必须主动结束所有 response，不能只依赖 `app.close()` 超时后强制退出。

## 当前模块导入副作用

Phase 0 后，仅 import `src/main/server.ts` 不会创建 context、注册 routes、启动 bridge/watcher/telemetry、listen 或安装 process handlers。`server.ts` 只在 `isDirectServerExecution(import.meta.url)` 为真时动态加载 standalone entry。

- `createWorkbenchServer(context, options)`：只构造 Fastify、注册 hooks/routes/listeners，适合 `app.inject()`；
- `createStandaloneServerComposition()`：显式测试/嵌入 factory，可创建隔离 context；
- `getOrCreateStandaloneServerComposition()`：正式 standalone 进程的 singleton composition；
- `startStandaloneServer()`：唯一负责 listen 与 process handlers 的正式入口。

Extensions handler 和 usage telemetry 的底层实现仍保留历史进程级 module state；生产 singleton composition 防止它们被多个正式 standalone context 竞争。当前不承诺同一进程并行运行多个生产工作台 server。

## 当前显式启动顺序

源码现有两个 `bridge.start()` 调用点，且正常 standalone boot 只有一个 owner：

1. `waitForHarnessBridgeConnected()` 在按需发送 harness 消息前的重试；
2. `serverStartup.ts` 在 event handlers 注册完成后的 standalone startup。

原先 SSE helper 后、listener wiring 前的 eager startup 已在独立 lifecycle 提交中移除。Fastify `app` 仍在所有 background bridge work 和 listener wiring 之前构造，避免旧 callback 在启动竞态中访问尚未初始化的 `app.log`。底部顺序已行为保持地抽到 `src/main/serverStartup.ts`：

1. 非阻塞 `bridgeLauncher.ensureBinaryReady()`，只更新 readiness 诊断；
2. 启动并登记可取消的 `bridgeLauncher.ensureRunning()` background task；
3. `bridge.start()`；
4. `imLiveWatcher.start()`；
5. 初始化 telemetry settings；
6. 初始化 global workflows；
7. `app.listen()`。

Composition/startup tests 锁定了“先注册 listeners，再由 standalone startup 启动 bridge”的顺序；按需发送路径仍可调用幂等 `start()` 作为连接重试。Shutdown 会 abort 并等待 sidecar background task，确保 launcher 不会在关闭完成后再 spawn。

## 当前关闭顺序与残余

`createWorkbenchShutdown()` 现在：

1. 立即调用有界 `app.close()`，停止接收新请求并等待在途请求；
2. abort/等待 sidecar startup task；
3. 在 app close 完成或超时后移除 direct-cli/bridge listeners；
4. 停止 IM watcher 与 usage telemetry；
5. 主动 end/clear SSE clients；
6. 以终态 async shutdown 等待 pending direct-CLI spawn，再回收全部 child；
7. 停止 launcher 并 dispose bridge。

Shutdown 使用 context-owned singleton promise；process exit 只存在于 standalone wrapper，factory/context 可被测试或后续 shell 复用。残余：`ImLiveWatcher.stop()` 仍是同步 API，不能等待其内部已开始的 scan；extensions 与 telemetry 仍有历史进程级 state，所以正式生产入口明确只支持每进程一个 standalone composition。

## Phase 0 `ServerContext` 边界

```ts
interface ServerContext {
  readonly services: {
    bridgeClient: HermitBridgeClient;
    bridgeConnection: HermitBridgeConnection;
    bridgeLauncher: HermitBridgeLauncher;
    teamProvisioning: TeamProvisioningService;
    systemManagerConfig: SystemManagerConfigService;
    workflowPrompt: WorkflowPromptService;
    conversationTelemetry: ConversationTelemetryService;
    localSessionScanner: LocalSessionScanner;
    loopAssetsScanner: LoopAssetsScannerService;
    directCli: DirectCliSessionManager;
    imLiveWatcher: ImLiveWatcher;
    ccSettings: HermitCcSettingsService;
    update: UpdateService;
    extensions: ExtensionsFacade;
  };
  readonly state: {
    teamStatsCache: Map<string, unknown>;
    sseClients: Set<SseClient>;
    directCliRoutes: Map<string, DirectCliRoute>;
    toolApprovalSettingsByName: Map<string, ToolApprovalSettings>;
    permissionSessionByRequestId: Map<string, PendingPermissionApproval>;
    bridgeSessionTeamCache: Map<string, unknown>;
    scheduleRunsById: Map<string, InMemoryScheduleRun[]>;
    scheduleRunLogsByKey: Map<string, unknown>;
  };
  readonly lifecycle: {
    listenerDisposers: Array<() => void>;
    backgroundStartupTasks: Set<Promise<void>>;
    startupAbortController: AbortController | null;
    startPromise: Promise<void> | null;
    disposePromise: Promise<void> | null;
  };
}
```

实际类型应从现有定义提取，不能为了快速通过而使用 `unknown`。上面的形状只定义所有权边界。

## 已实现 dispose 顺序

1. 建立 `disposePromise`，后续调用复用同一 promise；
2. 立即调用有界 `app.close()`，停止接收请求并等待在途请求；
3. abort/等待 background sidecar startup；
4. app close 完成或达到边界后移除 bridge/direct-cli listeners；
5. 停止 IM watcher 与 usage telemetry；
6. 主动结束 SSE responses 并清空 set；
7. 终态 shutdown direct-cli（拒绝新任务、等待 pending spawn、回收 children）；
8. stop launcher-owned sidecar；
9. dispose bridge connection，阻止重连；
10. standalone entry 移除 process handlers 并设置 exit code。

## 重复实例化高风险点

- `HermitBridgeConnection.dispose()` 是终态，不能复用已 dispose 实例；
- `TeamProvisioningService`、conversation telemetry 的 callback 依赖同一 `cc`/`bridge`/`svc`；
- direct-cli manager 是 CLI subprocess 的唯一 owner；
- bridge launcher 只能停止自己启动的 child，不能杀外部管理的 cc-connect；
- usage telemetry 保留模块 singleton；正式入口用进程级 singleton composition，测试 factory 不应并行启动 telemetry；
- listeners 与 signal handlers 不移除时，第二个 context 会重复处理消息和 shutdown；
- extensions watcher/emitter 必须在 composition root 创建一次，不能每个 route plugin 创建。

## Phase 0 最终所有权状态（2026-07-28）

- `createStandaloneServerComposition()` 是显式隔离 factory；正式入口使用 `getOrCreateStandaloneServerComposition()`，每进程只创建一套生产 `ServerContext` services/state。两者都不在构造时启动 bridge、watcher、HTTP listener 或 process handlers。
- `createWorkbenchServer(context, options)` 以 `WeakMap` 对同一 context 复用同一个 Fastify app，并只注册一套 bridge/direct-cli listeners；失败的 factory 创建会移除本轮新增 listeners。
- `startStandaloneServer()` 通过 `context.lifecycle.startPromise` 复用同一 context 的启动流程，防止重复调用 bridge/watcher/listen。
- shutdown 通过 `disposePromise` 保持幂等，顺序由 `serverProcessLifecycle.ts` 统一管理：立即 Fastify close/abort startup → 等待在途请求 → listeners → IM watcher → telemetry → SSE → direct CLI → launcher → bridge。
- import `server.ts` 或 `workbenchServer.ts` 不创建 stateful services，也不会监听端口；只有直接执行 `server.ts` 时才显式调用 standalone start。

## Task 0.1 退出条件

- 235 routes 全量 inventory 与源码逐项匹配；
- 共享 service、map/set、listener、startup 和 shutdown ownership 已登记；
- 高风险 route/test gaps 已登记；
- Phase 0 禁止变化的 HTTP、消息 ID、`isMeta`、TaskRef、soft-delete 和 lifecycle 语义已明确；
- 下一步只允许补 baseline tests 与抽取 factory seam，Electron 仍保持锁定。

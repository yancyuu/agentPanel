<!-- markdownlint-disable MD013 -->

# Server Context 与生命周期盘点（Phase 0）

> 本文记录 `src/main/server.ts` 当前由模块顶层隐式拥有的共享实例、内存状态、事件监听器和启动/关闭顺序。Phase 0 只显式化所有权并保持行为，不顺手修改产品语义。

当前已落地的 ownership seam：

- `serverContext.ts`：construction-only `ServerContext`、`ServerRuntimeState` 和 lifecycle bookkeeping；
- `serverEventHandlers.ts`：direct-cli/bridge listeners 的单点注册与精确 disposer；
- `serverStartup.ts`：standalone startup 编排；
- `serverProcessLifecycle.ts`：process signals 和有界 shutdown；
- Fastify `app` 在任何 background bridge work 与 listener wiring 之前构造。

尚未完成：extensions singleton adapter、其余 caches/schedule state、幂等 context dispose、route factory 和 import-time side-effect 移除。

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

Usage telemetry 另有模块级 singleton 状态：collector、scan interval、last scan 和 runtime status。Phase 0 先把其初始化/停止作为 context-owned lifecycle adapter；后续删除 usage telemetry 时单独修改行为和测试。

## 永久监听器

当前模块只适合“一个进程只 import 一次”，因为监听器没有 disposer：

- `directCliManager.on('event', ...)`：约 1222–1308；
- `bridge.on('reply', ...)`：约 1310–1328；
- `bridge.on('reply_stream', ...)`：约 1330–1358；
- `bridge.on('message', ...)`：约 1360–1375；
- `process.on('unhandledRejection', ...)`：7796；
- `process.on('SIGINT', shutdown)`：7799；
- `process.on('SIGTERM', shutdown)`：7800；
- `process.on('exit', ...)`：7803。

新的 context 必须保存 listener disposer。进程 signal handlers 应归 standalone executable entry 所有，不应由可复用的 server factory 隐式注册。

## 请求级资源

`GET /api/events` 为每个 SSE request 创建：

- 一条 `sseClients` 记录；
- 一个 15 秒 keepalive interval；
- 一个 `request.raw.close` 清理回调。

正常断连路径成对清理，但 server shutdown 必须主动结束所有 response，不能只依赖 `app.close()` 超时后强制退出。

## 当前模块导入副作用

仅 import `src/main/server.ts` 就会：

1. 读取 package 和路径；
2. 迁移/修复 Hermit 与 bridge 配置；
3. 创建全部进程级 service；
4. 配置 usage telemetry；
5. 启动 bridge connection；
6. 注册 direct-cli/bridge listeners；
7. 创建 Fastify、注册 plugins/routes；
8. 最终启动 sidecar、watcher、telemetry/workflow 并 `listen()`；
9. 注册 process signal/exit handlers。

因此在拆出 factory 之前无法安全使用 `app.inject()`，也无法在 Electron main 中重复构造或测试生命周期。

## 当前显式启动顺序

源码中存在三个 `bridge.start()` 调用点，其中两个属于正常 standalone boot：

1. SSE helper 后、direct-cli manager 构造前的 eager startup；
2. `waitForHarnessBridgeConnected()` 在按需发送 harness 消息前的重试；
3. 底部 standalone startup 编排中的第二次 boot 调用。

Fastify `app` 构造现已移动到所有 background bridge work 和 listener wiring 之前，避免旧 callback 在启动竞态中访问尚未初始化的 `app.log`。底部顺序已行为保持地抽到 `src/main/serverStartup.ts`：

1. fire-and-forget `bridgeLauncher.ensureBinaryReady()`；
2. fire-and-forget `bridgeLauncher.ensureRunning()`；
3. 第二次 `bridge.start()`；
4. `imLiveWatcher.start()`；
5. 初始化 telemetry settings；
6. 初始化 global workflows；
7. `app.listen()`。

`HermitBridgeConnection.connect()` 会在已有 `ws` 时返回，因此正常 boot 的第二次调用通常不会建立第二条 live socket；但若第一次同步创建 WebSocket 失败，第二次调用可能在 reconnect timer 之前重试。Phase 0 暂时保留全部三个调用点，并用 composition/startup tests 锁定当前行为；创建 `ServerContext` 前必须明确最终单一 ownership 和 listener 安装顺序。

另外，`ensureRunning()` 内部也会进行 binary readiness，当前两个 fire-and-forget 调用存在重复工作和错误传播不清晰的问题。Phase 0 先通过测试锁定现状，再决定是否在独立修复中调整。

## 当前关闭顺序与缺口

`server.ts` 约 7776–7803：

1. `imLiveWatcher.stop()`；
2. `directCliManager.shutdown()`；
3. `bridgeLauncher.stop()`；
4. `bridge.dispose()`；
5. 最多等待三秒 `app.close()`；
6. `process.exit(0)`；
7. `exit` listener 再次调用 direct-cli shutdown 兜底。

缺口：

- shutdown 没有 singleton promise，SIGINT/SIGTERM 可并发执行；
- 没有显式停止 usage telemetry interval；
- 没有主动 end/clear SSE clients；
- 没有移除 bridge/direct-cli/process listeners；
- 没有清理 pending permissions、routes 和 caches；
- `ImLiveWatcher.stop()` 不等待正在进行的 scan；
- context 内调用 `process.exit()` 会破坏 Electron/main-process 和测试复用。

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
    startPromise: Promise<void> | null;
    disposePromise: Promise<void> | null;
  };
}
```

实际类型应从现有定义提取，不能为了快速通过而使用 `unknown`。上面的形状只定义所有权边界。

## 建议 dispose 顺序

1. 建立 `disposePromise`，后续调用复用同一 promise；
2. 停止接受新 HTTP 请求；
3. 停止 watcher、telemetry、schedule/direct-cli 新任务生产；
4. 移除或 guard bridge/direct-cli listeners；
5. 主动结束 SSE responses 并清空 set；
6. 取消/拒绝 pending permission requests；
7. shutdown direct-cli children；
8. dispose bridge connection，阻止重连；
9. stop launcher-owned sidecar；
10. 有界等待 in-flight work；
11. 清理 caches/maps；
12. 完成 Fastify close；
13. standalone entry 移除 process handlers 并设置 exit code。

## 重复实例化高风险点

- `HermitBridgeConnection.dispose()` 是终态，不能复用已 dispose 实例；
- `TeamProvisioningService`、conversation telemetry 的 callback 依赖同一 `cc`/`bridge`/`svc`；
- direct-cli manager 是 CLI subprocess 的唯一 owner；
- bridge launcher 只能停止自己启动的 child，不能杀外部管理的 cc-connect；
- usage telemetry 当前是隐藏模块 singleton，两个 context 会互相停止/覆盖；
- listeners 与 signal handlers 不移除时，第二个 context 会重复处理消息和 shutdown；
- extensions watcher/emitter 必须在 composition root 创建一次，不能每个 route plugin 创建。

## Task 0.1 退出条件

- 235 routes 全量 inventory 与源码逐项匹配；
- 共享 service、map/set、listener、startup 和 shutdown ownership 已登记；
- 高风险 route/test gaps 已登记；
- Phase 0 禁止变化的 HTTP、消息 ID、`isMeta`、TaskRef、soft-delete 和 lifecycle 语义已明确；
- 下一步只允许补 baseline tests 与抽取 factory seam，Electron 仍保持锁定。

# Proposal: App 与 CLI 状态同步

## Why

用户在 App（桌面工作台）和 CLI 之间切换时，两者状态各自为政：App 登录了 AgentBus，CLI 仍是未登录；worker 的 Lark 凭证上报、CLI 的 token 池认领因读不到 App 的登录态而失败。产品要求：任一端登录/登出，另一端立即处于一致状态；用量上报等开关两端行为一致。

## What Changes

- **登录态双向桥接**：App 侧（advanced-connections 的 agentbus 连接）登录成功、token 刷新、登出时，同步派生写入/删除 CLI 的 `~/.hermit/auth/openhermit.json`；CLI 侧（auth login/refresh/logout）同样同步派生写入/更新/删除 App 的默认 agentbus 连接记录与 secret。两端 secret 同源后，worker（OpenHermitAuthClient）与 Lark 凭证上报自然获得 App 的登录态。
- **刷新写穿透**：任一端刷新 token 成功后必须写穿透到另一份存储，避免 refresh token 轮换导致两端互相踢出。
- **用量开关默认值对齐**：`uploadProviders` 默认播种统一为 `['claudecode','codex','pi']`（App 播种侧补齐 pi）；修正 CLI 开启路径在老配置缺少 canonical 字段时默认补 `conversationUploadEnabled: true` 的行为（消息正文上报必须显式 opt-in，两端一致）。
- **不做的**：App 的聚合快照上报通道（connections `usage.aggregates` 权限）是 App 独有通道，不做 CLI 映射；presence/远程任务拉取同理。

## Capabilities

### New Capabilities

- `cli-app-auth-sync`：App 与 CLI 之间登录态（登录/刷新/登出）的双向同步与 token 刷新写穿透。

### Modified Capabilities

- `asset-precipitation`：无（不相关）。用量开关同属 `taskBus.telemetry` 共享文件，本变更仅对齐默认值与修正 opt-in 语义，不设独立 capability，相关需求并入 `cli-app-auth-sync`。

## Impact

- **写穿透点**：`AdvancedConnectionService`（登录完成/getValidSecret 刷新/logout/删除连接）、`bin/lib/auth.mjs`（登录成功/refresh/logout/dev-login）、`src/main/services/auth/OpenHermitAuthClient.ts`（worker 刷新）。
- **桥接模块**：新增共享的派生转换（connection secret ↔ openhermit.json schema），CLI（.mjs）与 TS 两侧都要可用——注意 bin/lib 是 ESM .mjs、src 是 TS，桥接逻辑的放置要避免重复实现（参考 telemetryWorker 的 bundle 共享模式或放 src/shared）。
- **风险面**：刷新竞态（两端同时刷新）、App 刷新失败删 secret 级联删除 CLI store（不应级联——登出才删，刷新失败各自降级）。
- **测试**：两端登录/刷新/登出的交叉断言（App 登录 → CLI auth status 已登录；CLI logout → App 连接 auth_required）。
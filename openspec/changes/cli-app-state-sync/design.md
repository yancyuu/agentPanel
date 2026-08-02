# Design: 登录态双向桥接

## Context

现状（已调查）：同一服务端（agentbus.skg.com）、同一 device-code 协议，但两套存储互不相认——CLI/worker/Lark 读 `~/.hermit/auth/openhermit.json`（写者：auth.mjs 登录/刷新、OpenHermitAuthClient worker 刷新），App 读 `~/.hermit/connections/`（写者：AdvancedConnectionService 登录/刷新/登出）。token 字段半同构（accessToken/refreshToken/tokenType/expiresAt 同名；CLI 多 account/issuer/clientId/scope 字符串，App 多 connectionId/providerId/issuerOrigin）。用量开关已共享 settings.json，不在本设计的同步范围内（仅对齐默认值）。

## Goals / Non-Goals

**Goals**

- 任一端登录成功，另一端在下一次读取时即为已登录（worker 的 Lark 上报、CLI token 池认领立即可用）。
- 任一端主动登出，另一端同步失效。
- token 刷新不互相踢出（写穿透）。

**Non-Goals**

- 不合并两份存储为一份（改造成本与回归面过大；桥接派生即可满足产品语义）。
- 不做连接级 permissions 与 CLI 的映射（App 独有通道）。
- 不处理多连接场景：CLI 侧只桥接 providerId='openhermit-agentbus' 且 managedDefault 的连接（用户自加的同 provider 连接不桥接，避免多源写入）。

## Decisions

### D1：双向派生写，各自保留 schema 与刷新权

不设单一事实源。每个写点完成自己的状态变更后，把结果**派生转换**写入另一份存储：

- **App → CLI**：`buildAuthStoreFromConnection(record, secret)` —— provider='openhermit'、issuer=record.baseUrl、baseUrl 同、clientId='openhermit-cli'、account 取 record.account（字段映射 id/email/name/tenantName）、token 取 secret（scope 由 scopes 数组 join）。写点：`completeAuth`（登录成功）、`getValidSecret`（刷新成功）、logout/删除连接（删 openhermit.json）。
- **CLI → App**：`buildConnectionSecretFromAuthStore(store)` + 更新默认连接 record（state='authenticated'、account、grantedScopes）。写点：`performDeviceAuthLogin` 成功、`refreshExpiredOpenHermitToken` 成功、logout（默认连接 secret 删除 + state='auth_required'）、dev-login（provider 写 'openhermit-dev' 时也桥接，secret 照常写）。
- worker 的 `OpenHermitAuthClient` 刷新 openhermit.json 后同样写穿透到默认连接 secret。

### D2：刷新失败不级联，只有显式登出才删除对方

App 刷新失败（现有行为：删 secret + state=auth_required）**不删** openhermit.json——CLI 侧可能只是暂时网络失败，降级各自处理（CLI 自己的过期判定会生效）。反向同理。只有用户显式 logout/删除连接才双向删除。理由：网络抖动不应把另一端踢下线；状态收敛交给各自的下一次成功刷新。

### D3：竞态靠「刷新前先重读」而不是锁

两端同时刷新是低概率事件（App 90s 提前量 vs CLI 过期才刷）。写穿透时先重读目标存储：若目标里的 accessToken 比本端刚刷出的更新（updatedAt 更晚），放弃写入。不引入分布式锁；服务端 refresh token 轮换场景下，后写者以较新 token 为准，两端最终收敛。

### D4：桥接代码放 src/shared，bin 侧走 dist bundle 同款加载

转换函数（两个方向的 build*）放 `src/shared/authSync/`（纯函数 + 文件 IO 辅助，无依赖）。App 侧直接 import；CLI（bin/lib/*.mjs）通过现有的 vendor/打包共享路径加载（若 bin 不能直引 src/shared，则在 bin/lib 放薄封装 import 同一份文件——参照 alias-loader 已有机制，选零重复的实现方式）。

### D5：用量开关对齐（小修）

- App 播种（serverOperations.ts）`uploadProviders` 补 `'pi'`，与 CLI 默认一致。
- 修 `usageCommand.mjs:373-378`：老配置无 canonical 字段时不再默认补 `conversationUploadEnabled: true`——消息正文上报在两端都保持显式 opt-in。

## Risks / Trade-offs

- [桥接写穿透遗漏某个写点导致两端漂移] → 写点集中（D1 列出全部），每个写点配交叉断言测试；后续新增写点由宪法评审拦截。
- [refresh token 轮换下两端各刷各的仍可能互相失效] → D3 重读放弃旧写 + 写穿透保证任一端刷新后两端同步；极端竞态下最坏结果是一端需重新登录，可接受。
- [用户自加的同 provider 连接不桥接，产生"为什么这个连接登录了 CLI 没登录"] → 文档与 UI 说明默认连接即 CLI 共享登录态；自加连接属高级用法。

## Migration Plan

纯新增写穿透，无存量迁移。首次生效后两端自然收敛：已登录的一侧在下一次刷新/操作时会桥接另一侧。回滚 = 移除写穿透调用，两份存储回到各自为政（无数据损坏风险）。

## Open Questions

- CLI 侧 `auth status` 是否应展示「登录来源：App/CLI」——提升可观测性，非必须，后续可加。

# Tasks: App 与 CLI 状态同步

## 1. 桥接模块

- [x] 1.1 `src/shared/authSync/`：`buildAuthStoreFromConnection(record, secret)` 与 `buildConnectionSecretFromAuthStore(store)` 纯函数（含 account/scope 字段映射）+ 写穿透辅助（重读比较 updatedAt、较新则放弃）
- [x] 1.2 CLI 侧加载方式确定（bin/lib 薄封装引用同一份实现，零重复）

## 2. App → CLI 写穿透

- [x] 2.1 `AdvancedConnectionService`：登录完成（completeAuth）派生写 openhermit.json
- [x] 2.2 `getValidSecret` 刷新成功写穿透；logout/删除默认连接时删除 openhermit.json
- [x] 2.3 仅处理 providerId='openhermit-agentbus' 且 managedDefault 的连接

## 3. CLI → App 写穿透

- [x] 3.1 `auth.mjs`：device-code 登录成功、refresh 成功、dev-login 成功写穿透默认连接 secret + record
- [x] 3.2 CLI logout：删默认连接 secret + state='auth_required'
- [x] 3.3 `OpenHermitAuthClient`（worker）刷新后写穿透

## 4. 用量开关对齐

- [x] 4.1 App 播种 uploadProviders 补 pi
- [x] 4.2 修 usageCommand.mjs 老配置默认补 conversationUploadEnabled:true 的行为

## 5. 测试与验证

- [x] 5.1 桥接纯函数映射与 updatedAt 判放弃用例
- [x] 5.2 交叉断言：App 登录 → CLI auth status 已登录；CLI 登录 → App 连接 authenticated；CLI logout → App auth_required；App 刷新 → CLI store 一致；刷新失败不级联
- [x] 5.3 `pnpm vitest run` 全量 + `pnpm typecheck` 全绿
- [ ] 5.4 人工验收：App 登录后 CLI `auth status`/`usage status` 已登录；CLI logout 后 App 显示未授权

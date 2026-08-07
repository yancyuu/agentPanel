## Purpose

App（桌面工作台）与 CLI 共享一致的登录态：任一端登录、刷新或登出，另一端自动处于一致状态，worker 与 CLI 各命令无需用户重复登录即可使用 App 的授权。

## ADDED Requirements

### Requirement: App 登录同步到 CLI

App 的默认 AgentBus 连接（providerId='openhermit-agentbus' 且 managedDefault）登录成功后，系统 SHALL 将连接 secret 派生写入 CLI 的 auth store（`~/.hermit/auth/openhermit.json`，schema 与 CLI 登录产物一致），使 CLI 的 auth status、token 池认领、worker 的 Lark 凭证上报立即处于已登录状态。

#### Scenario: App 登录后 CLI 已登录

- **WHEN** 用户在 App 完成默认连接登录，随后执行 CLI `auth status`
- **THEN** CLI 报告已登录，账号信息与 App 当前账号一致

#### Scenario: worker 获得 App 登录态

- **WHEN** 用户仅在 App 登录（CLI 从未登录），worker 执行 Lark 凭证上报
- **THEN** worker 能读取有效 token 并完成上报，不提示未授权

### Requirement: CLI 登录同步到 App

CLI 登录成功（device-code 或 dev-login）后，系统 SHALL 更新 App 默认连接记录（state='authenticated'、账号信息）并写入对应 secret，使 App 连接面板与 Token 池等功能立即可用。

#### Scenario: CLI 登录后 App 已登录

- **WHEN** 用户仅通过 CLI 完成登录，随后打开 App 连接面板
- **THEN** 默认连接显示已登录与当前账号，Token 池操作可用

### Requirement: 刷新写穿透

任一端刷新 token 成功后，系统 SHALL 将新 token 写穿透到另一份存储。写穿透前 MUST 重读目标存储，若目标中的 token 更新（updatedAt 更晚）MUST 放弃本次写入。刷新失败 MUST NOT 删除另一份存储——仅显式登出才双向失效。

#### Scenario: 刷新后两端 token 一致

- **WHEN** App 侧刷新 token 成功
- **THEN** CLI auth store 中的 accessToken/refreshToken/expiresAt 与 App secret 一致

#### Scenario: 较新 token 不被覆盖

- **WHEN** 一端写穿透时发现目标存储的 token updatedAt 更晚
- **THEN** 本次穿透写入被放弃，目标存储保持不变

#### Scenario: 刷新失败不级联

- **WHEN** App 侧刷新失败并按既有行为降级（删除自身 secret、state 置 auth_required）
- **THEN** CLI 的 auth store 不被删除，CLI 侧的过期判定独立生效

### Requirement: 登出双向同步

任一端显式登出（CLI logout 或 App 退出登录/删除默认连接）时，系统 SHALL 删除另一端的对应登录态（auth store 文件或连接 secret 并将 state 置为未授权）。

#### Scenario: CLI 登出后 App 未登录

- **WHEN** 用户执行 CLI logout，随后查看 App 连接面板
- **THEN** 默认连接显示未授权状态，需重新登录

### Requirement: 用量开关默认值与 opt-in 语义一致

`taskBus.telemetry.uploadProviders` 的两端默认播种值 MUST 一致（含 pi）。消息正文上报（conversationUploadEnabled）在两端 MUST 保持显式 opt-in：任何开启路径不得在用户未明确选择时默认补 true。

#### Scenario: 老配置不被动开启正文上报

- **WHEN** 用户的 settings.json 缺少 canonical 开关字段，通过 CLI 开启本地上报
- **THEN** conversationUploadEnabled 保持未开启，需用户显式选择后才为 true

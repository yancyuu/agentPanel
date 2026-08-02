## Purpose

CLI 核心功能在 App 端完整可用，且 Windows 与 macOS 双平台行为正确：usage 采集控制、立即上报、团队协作开关、飞书个人助理管理均可在 App 内完成，平台差异不产生功能缺失或误报。

## ADDED Requirements

### Requirement: App 端 usage 采集控制

App 的 Usage 面板 SHALL 提供「开始采集」「停止采集」「立即上报」操作，调用既有服务端能力（telemetry.enabled 启停、手动 scan），并展示最近一次操作结果（成功/失败与时间）。操作 MUST 与 CLI `usage start/stop/report` 语义一致（同一 settings.json 与 worker 生命周期）。

#### Scenario: App 开启采集后 CLI 状态一致

- **WHEN** 用户在 App 点击「开始采集」，随后执行 CLI `usage status`
- **THEN** CLI 显示采集已启用（同一 settings.json 生效）

#### Scenario: 立即上报结果可见

- **WHEN** 用户点击「立即上报」
- **THEN** 面板显示本次扫描上报结果（成功摘要或失败原因）与执行时间

### Requirement: 飞书个人助理 App 端可用

App SHALL 提供飞书个人助理的创建与列表能力，与 CLI `create-feishu-assistant`/`list-feishu-assistants` 语义一致（复用同一实现，不另写逻辑）。

#### Scenario: App 创建助理后 CLI 列表可见

- **WHEN** 用户通过 App 创建飞书个人助理，随后执行 CLI `list-feishu-assistants`
- **THEN** 列表包含该助理

### Requirement: 团队协作开关 App 端可用

App SHALL 提供团队协作（collaboration）启用/停用开关，与 CLI `collaboration start` 语义一致（同步团队指令注入），开关状态可见。

#### Scenario: 开关状态持久一致

- **WHEN** 用户在 App 打开团队协作开关，随后查看 CLI 侧团队协作状态
- **THEN** 两端状态一致

### Requirement: Windows 平台正确性

Windows 上 MUST NOT 出现因 POSIX 假设导致的功能失败或误报：openspec 包装脚本安装可重复执行；凭证文件安全检测不得以 POSIX mode 误报；原子写在目标文件被占用（EPERM）时 MUST 重试（rm+rename）而非直接失败。

#### Scenario: Windows 重复安装 openspec 包装脚本

- **WHEN** Windows 上第二次调用 openspec 包装脚本安装
- **THEN** 正常返回包装脚本路径，openspec 命令可用

#### Scenario: 原子写 EPERM 重试

- **WHEN** Windows 上原子写目标文件被其他进程占用
- **THEN** 写入按 rm+rename 重试并最终成功或给出明确错误，不产生损坏文件

### Requirement: CI 双平台测试

CI 的测试 job MUST 在 ubuntu、windows、macOS 三个平台运行。

#### Scenario: macOS 跑测试

- **WHEN** 推送触发 CI
- **THEN** test job 的 matrix 包含 macos-latest 且执行测试

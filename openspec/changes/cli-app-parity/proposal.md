# Proposal: CLI 功能 App 端对等与双平台保障

## Why

产品要求 CLI 的全部功能在 App 端可用，且 Windows/macOS 双平台可用。审计发现：usage start/stop/report、collaboration start、飞书个人助理创建等 CLI 命令在 App 端无入口；openspec 包装脚本在 Windows 上因无保护的 chmod 调用而二次调用必失败；凭证安全检测在 Windows 恒误报；CI 缺 macOS 测试。

## What Changes

- **Usage 控制 UI**：设置-Usage 面板补「开始采集/停止采集/立即上报」操作（API 已存在：taskBusSettingsRoutes、usageTelemetryRoutes），含状态反馈。
- **飞书个人助理对等**：`create-feishu-assistant`/`list-feishu-assistants` 在 App 端提供 API + UI（复用 bin/lib/feishuAssistant.mjs 既有实现，模式同 aikey 复用）。
- **collaboration start 入口**：团队协作启用在 App 提供开关（API 已存在：taskBusSettingsRoutes 的 collaboration 标志）。
- **Windows 修复**：凭证 fileSecure 检测平台化（win32 跳过 POSIX mode 判定）；原子写统一 EPERM 重试（收敛到 shared 工具）。
- **CI 补 macOS**：ci.yml test matrix 增加 macos-latest。
- **不做的**：桌面自更新 UI（桌面走安装包升级，刻意禁用）；`auth dev-login`（开发后门保持 CLI 专有）；`services` 分项管理（web=App 自身，usage 已由控制 UI 覆盖）。

## Capabilities

### New Capabilities

- 无（均为既有能力的入口补全与平台修复，见 Modified）。

### Modified Capabilities

- `cli-app-auth-sync`：无需求变更。

本变更主要是入口补全与平台修复，行为契约集中于 usage 控制与飞书助理对等，统一放入新 capability `cli-feature-parity`。

### New Capabilities（修正）

- `cli-feature-parity`：CLI 核心命令在 App 端的可用性保障（usage 采集控制、立即上报、团队协作开关、飞书个人助理创建与列表）及 Windows/macOS 双平台正确性。

## Impact

- UI：`TaskBusSection.tsx`（usage 控制）、设置-团队协作开关、飞书助理 UI（放置位置随既有数字员工创建流程）。
- 路由：复用既有 API；飞书助理新增 routes（调用 bin/lib/feishuAssistant.mjs）。
- Windows：`CredentialService.ts`、`shared` 原子写工具、若干 rename 点收敛。
- CI：`.github/workflows/ci.yml` test matrix 加 macos-latest。

# Design: CLI 功能对等补全

## Context

审计结论（可直接采信）：usage 启停/上报 API 已存在（`taskBusSettingsRoutes.ts:50-74`、`usageTelemetryRoutes.ts:38`）仅缺 UI；`bin/lib/feishuAssistant.mjs` 有完整飞书助理实现且 App 已有复用 bin/lib 的先例（aikey）；collaboration 标志同步 API 已存在（`taskBusSettingsRoutes.ts:106`）。Windows 高危 bug（openspec chmod）已修；剩中风险项。

## Goals / Non-Goals

**Goals**：审计表中「API 有、UI 缺失」与「完全缺失」的核心命令在 App 可用；Windows 中风险项收敛；CI 双平台。
**Non-Goals**：桌面自更新、dev-login、services 分项管理（见 proposal）。

## Decisions

### D1：Usage 控制并入既有 TaskBusSection，不新设页面

在 Usage 监测面板加操作行：开始采集（PUT task-bus telemetry.enabled=true，走既有 startTelemetry 接线）、停止采集、立即上报（POST /api/telemetry/scan）。操作结果行内反馈（成功/失败+时间），与连接面板 OutcomeLine 同风格。autostart 管理不做 UI（桌面 reconcile 已覆盖语义）。

### D2：飞书助理复用 bin/lib/feishuAssistant.mjs，模式同 aikey

新增 routes：GET/POST `/api/feishu-assistants`（list/create），服务端经 loadAikeyRuntime 同款动态 import 调用 bin/lib 实现；UI 挂在数字员工创建流程附近（TeamDetailView 或设置合适位置，跟随既有 PlatformSetupQR 的放置），列表 + 创建（含扫码流程复用 platformSetupRoutes 已有能力，如 feishuAssistant 自带扫码则走其流程）。不重写逻辑。

### D3：collaboration 开关放团队设置区

UI 开关调既有 collaboration 标志 API（启用/停用团队指令注入同步），状态可见。

### D4：Windows 修复取最小集

- `CredentialService.ts:291`：win32 跳过 POSIX mode 判定（以"位于用户 profile"为准）。
- 原子写：把 `AgentCliShimProvisioner.ts:90-97` 的 EEXIST/EPERM rm+rename 重试提为 `src/shared/writeAtomic`（.mjs+.d.mts 同款共享），收敛 authSync、SystemCredentialSecretStore、TeamWorkspaceService、desktop/main 四处 rename 点。
- Windows 签名暂不做（无证书），release 文档注明未签名 + SmartScreen 指引。

### D5：CI test matrix 加 macos-latest

ci.yml test job 的 os matrix 改 `[ubuntu-latest, windows-latest, macos-latest]`。

## Risks / Trade-offs

- [飞书助理 bin/lib 依赖交互式终端输入] → 调查后如存在，App 端走其可编程入口或参数化封装；真不可编程的部分在汇报中标注，不硬接。
- [macOS CI 首次跑可能出现平台相关测试失败] → 以修复测试环境隔离问题为限，不改产品语义。

## Migration Plan

无迁移。CI 变更即 push 即生效。

## Open Questions

- 无。

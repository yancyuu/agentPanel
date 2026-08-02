# Tasks: CLI 功能 App 端对等与双平台保障

## 1. Usage 控制 UI

- [x] 1.1 TaskBusSection 增加 开始采集/停止采集（PUT task-bus）+ 立即上报（POST /api/telemetry/scan）操作行
- [x] 1.2 操作结果反馈（OutcomeLine 风格：成功摘要/失败原因+时间）

## 2. 飞书个人助理对等

- [x] 2.1 调查 bin/lib/feishuAssistant.mjs 的可编程入口；新增 GET/POST `/api/feishu-assistants`（动态 import 复用，模式同 aikey）
- [x] 2.2 UI：助理列表 + 创建入口（放置随既有数字员工/渠道设置区）

## 3. 团队协作开关

- [x] 3.1 UI 开关调既有 collaboration 标志 API，状态可见

## 4. Windows 修复

- [x] 4.1 CredentialService fileSecure：win32 跳过 POSIX mode 判定
- [x] 4.2 `src/shared/writeAtomic`（.mjs+.d.mts）：EPERM/EEXIST rm+rename 重试；收敛 authSync、SystemCredentialSecretStore、TeamWorkspaceService、desktop/main 四处
- [x] 4.3 release 文档注明 Windows 未签名与 SmartScreen 指引

## 5. CI

- [x] 5.1 ci.yml test matrix 加 macos-latest

## 6. 测试与验证

- [x] 6.1 usage 控制（启停写 settings、scan 调用、结果反馈）用例
- [x] 6.2 飞书助理 routes（list/create 复用 bin/lib）用例
- [x] 6.3 writeAtomic 重试用例、fileSecure 平台分支用例
- [x] 6.4 `pnpm vitest run` 全量 + `pnpm typecheck` 全绿

<!-- markdownlint-disable MD013 -->

# Feature Specification: 独立私人工作台桌面应用

## Overview

将当前包含在 `agentcli` npm 包中的 Web 工作台完整迁移为独立的 Windows/macOS 桌面应用，并把 CLI 收缩为消息总线、用户/鉴权和 token 池三个领域。第一版沿用当前 UI 风格，核心交互改为私人动态：一个任务是一条动态，用户在动态下评论即发起下一轮智能体执行。

## Problem Statement

当前 `agentcli` 同时承担 CLI、Fastify 工作台 server、React renderer、cc-connect 运行时接入和 usage telemetry，导致：

- `src/main/server.ts` 约 7,800 行并内联注册约 99 个 `/api` 路由，难以独立迁移或安全维护；
- CLI 依赖 localhost 工作台 server，无法真正保持轻量和独立；
- 工作台作为 CLI 附属功能分发，不符合桌面产品的生命周期、安装和升级方式；
- 当前管理后台式信息架构不适合私人用户持续发布任务、查看执行和追加下一轮指令；
- usage telemetry 与飞书个人授权凭证上报混在同一产品边界中，难以明确删除前者并保留后者。

如果不先拆分 server，再直接套 Electron 壳或改 UI，将把结构重构、进程生命周期和产品行为变更混在一起，显著增加消息、任务、授权和运行时回归风险。

## Product Boundary

### Slim CLI

`agentcli` 第一版只保留：

- 消息总线及必要的 teams/tasks/collaboration 能力；
- 用户和 AgentBus 鉴权；
- token 池的认领、恢复和状态能力。

CLI 不再包含或启动 Web 工作台、renderer、Electron、usage worker 或 usage telemetry。

### Desktop Workbench

独立桌面应用负责：

- 当前工作台 UI 和工作台后端；
- 私人动态、评论和执行轮次；
- 数字员工 GUI 创建与重新授权；
- 飞书 lark-cli 个人授权及授权凭证上报；
- Windows/macOS 桌面生命周期与安装包。

## User Scenarios & Testing

### Primary Scenario: 发布私人任务动态

1. 用户启动桌面工作台。
2. 用户发布一个任务。
3. 系统创建一条私人动态和第一轮智能体执行。
4. 用户在动态时间线中查看执行状态、输出、错误和产物。
5. 第一轮结束后，用户评论“补充测试并重新验证”。
6. 系统只创建一次新的执行轮次，继承该动态上下文和默认智能体。
7. 第二轮结果继续显示在同一动态中。

### Primary Scenario: 创建飞书数字员工

1. 用户在桌面应用中创建数字员工并选择飞书。
2. 应用检测 lark-cli 并提示个人用户授权。
3. 应用以真实 lark-cli profile、`as user` 和 `--domain all` 发起或刷新授权。
4. 授权成功后继续创建数字员工，并执行飞书授权凭证上报。
5. 授权失败、取消或过期时，创建流程停止并提供中文重试指引。

### Alternative Scenario: 非飞书渠道

1. 用户创建数字员工并选择非飞书渠道。
2. 系统不启动 lark-cli 个人授权。
3. 系统按原渠道流程继续创建。

### Alternative Scenario: 收件箱处理

1. 用户打开收件箱。
2. 用户看到等待回复、执行完成和执行失败的私人动态。
3. 用户进入任一动态并评论，触发下一轮执行。

### Alternative Scenario: CLI 独立运行

1. 桌面应用未启动。
2. 用户运行保留的消息总线、鉴权或 token 池 CLI 命令。
3. 命令通过共享 service/CLI adapter 工作，不尝试启动工作台 server 或 Electron。

### Edge Cases

- 同一评论因双击、网络重试或 renderer 重载重复提交：最多创建一个下一轮。
- app 在评论保存后、执行派发前崩溃：重启后能够恢复或安全重试，不重复创建轮次。
- 智能体输出或系统日志被追加到时间线：不得被误认为用户评论并触发执行。
- lark-cli 未安装或不在交互 shell PATH：显示明确的检测和恢复路径，不静默继续。
- 飞书个人授权成功但凭证上报失败：授权保持有效，应用提示上报失败并允许安全重试。
- Electron 重复启动：复用或聚焦已有实例，不重复创建 Fastify、watcher 或 bridge。
- app 退出：Fastify、watcher、direct-cli 和所属子进程均正常关闭。
- Windows/macOS 路径、终端和子进程行为不同：使用统一 runtime discovery 和平台适配层。

## Functional Requirements

### FR-1: Server Split Is A Hard Prerequisite

任何桌面壳、私人动态 UI、CLI 包剥离或安装包实现开始前，必须先完成 `src/main/server.ts` 的行为保持型拆分并通过验证。

### FR-2: Thin Server Composition Root

`src/main/server.ts` 必须收缩为配置、依赖装配、route 注册、启动和关闭入口。业务 route 必须位于按领域划分的 Fastify route modules 中。

### FR-3: Single Shared Server Context

工作台进程必须只创建一个共享 server context。route modules 通过显式依赖访问 service、bridge、watcher、SSE client 和 runtime map，不得自行重复实例化有状态依赖。

### FR-4: Behavior-Preserving Route Extraction

Phase 0 拆分不得计划性修改现有 HTTP 路径、请求体、响应体、错误语义、消息 ID、任务状态映射或进程生命周期。

### FR-5: Independent Desktop Product

工作台必须作为独立 Electron 应用构建和分发，不再作为 `agentcli web` 或 CLI 交互菜单中的 Web 工作台启动。

### FR-6: Independent Slim CLI

桌面应用未运行时，CLI 保留的三个领域仍必须可用。CLI 不得依赖桌面工作台的 localhost server。

### FR-7: Current UI Style Reuse

第一版必须复用当前主题、Tailwind/Radix 组件和主要二级页面。不得把 Multica 视觉复刻作为首版要求。

### FR-8: Private Activity

每个用户任务必须对应一个私人 `Activity`，其时间线包含用户输入、执行轮次、智能体结果、错误和产物引用。

### FR-9: Comment Creates Next Round

用户评论必须以幂等方式创建下一轮 `ExecutionRound`。创建评论和创建轮次必须具备一致性保证；系统事件和智能体输出不得触发轮次。

### FR-10: Context And Agent Inheritance

新轮次默认继承 activity 上下文和上一轮智能体。第一版可以只提供默认智能体，但存储和 contracts 必须包含稳定的 `agentId`。

### FR-11: Inbox Projection

桌面应用必须提供私人收件箱视图，至少区分等待用户、执行完成和执行失败的动态。

### FR-12: Feishu Personal Authorization

创建数字员工时选择飞书，必须完成 lark-cli 个人用户 `as user --domain all` 授权；不得替换为 bot/app token 或 AgentBus auth token。

### FR-13: Authorization Failure Stops Creation

飞书个人授权失败、取消或缺失时，数字员工创建必须提前停止，不得继续创建半完成的团队或渠道绑定。

### FR-14: Remove Usage Telemetry

CLI 和桌面应用均不得启动、打包或暴露 usage telemetry worker、usage 定时上报或 usage 导出流程。

### FR-15: Preserve Feishu Credential Reporting

删除 usage telemetry 时必须保留飞书个人授权凭证上报，并通过独立模块和测试证明两者没有耦合。

### FR-16: Cross-Platform Packaging

首版必须能够在 CI 中构建 Windows x64、macOS arm64 和 macOS x64 桌面安装包。

### FR-17: Graceful Desktop Lifecycle

应用必须保证单实例启动、loopback-only server、可信 origin 校验和可验证的 shutdown，不得遗留所属 server、watcher 或子进程。

## Non-Functional Requirements

### NFR-1: Local-First Privacy

私人动态、评论和执行记录默认只保存在本地工作区。首版不引入公开动态、云同步或多用户权限。

### NFR-2: Chinese-First UI

新增可见文案、错误、授权提示和恢复指引必须优先使用简体中文。

### NFR-3: Test-First Refactoring

拆分或修改 teams/tasks/messages、setup、auth、runtime、provider 和 Feishu 流程前，必须确认现有测试或先补充聚焦测试。

### NFR-4: Feature Architecture

私人动态等新跨进程功能必须遵循 `docs/FEATURE_ARCHITECTURE_STANDARD.md`，使用 contracts、core、main adapters/composition 和 renderer public entrypoints。

### NFR-5: Idempotency

重复评论提交、重启恢复和派发重试不得造成重复执行轮次。

### NFR-6: Security

Electron renderer 禁用 Node integration 并启用 context isolation；本地 server 仅监听 loopback，不暴露任意文件系统或进程能力。

### NFR-7: No Hidden Usage Reporting

删除 usage telemetry 后，不得以其他名称或后台进程继续采集或上报 usage 数据。

## Success Criteria

| ID    | Criterion          | Measure                                                                     |
| ----- | ------------------ | --------------------------------------------------------------------------- |
| SC-1  | server 拆分完成    | `server.ts` 目标不超过约 400 行，现有 routes 全部登记到模块或有明确删除记录 |
| SC-2  | 拆分保持行为       | 类型检查、server build 和关键 route/业务回归通过，无计划外 API 变化         |
| SC-3  | 工作台完全移出 CLI | npm 包不包含 renderer、Electron、工作台 server 启动入口或 usage worker      |
| SC-4  | CLI 保持独立       | 桌面 app 停止时，消息总线、鉴权和 token 池命令仍可运行                      |
| SC-5  | 私人动态可用       | 创建任务形成 Activity 和 Round 1；每条用户评论恰好创建一个后续 Round        |
| SC-6  | 收件箱可用         | 用户可查看等待用户、完成和失败的动态并进入详情                              |
| SC-7  | 飞书授权正确       | 飞书创建流使用真实 lark-cli `as user --domain all`，失败时提前停止          |
| SC-8  | telemetry 边界正确 | usage telemetry 不启动、不打包；飞书凭证上报仍有测试覆盖并可用              |
| SC-9  | 双平台首版         | CI 产出 Windows x64、macOS arm64/x64 可启动安装包                           |
| SC-10 | 生命周期干净       | 退出 app 后无该 app 所属 Fastify、watcher 或 direct-cli 残留进程            |

## Assumptions

- 第一版采用 Electron，以复用 Node/Fastify 服务和现有 React renderer。
- 当前 UI 风格满足首版，不进行整套视觉重设计。
- 首版可提供未签名安装包；签名、公证和自动更新后续补充。
- 多智能体是后续能力，首版仅预留 `agentId` 和指派契约。
- `~/.hermit/` 仍是默认本地数据目录。

## Dependencies

- 现有 `src/main/server.ts`、`src/main/services/` 和 Fastify routes。
- 现有 React renderer 和统一 HTTP API adapter。
- 现有 cc-connect / hermit-bridge 接入。
- 现有 lark-cli 个人授权与飞书凭证上报基础链路。
- Windows 和 macOS CI runner。

## Out of Scope

- Multica 视觉风格复制；
- 完整多智能体并行调度和 agent society；
- 公开社交动态、团队动态或多用户权限；
- 云端同步；
- 第一版代码签名、公证和自动更新；
- 全量重做现有设置、Extensions、Skills、编辑器和 review UI；
- usage telemetry、usage worker 和 usage 数据导出。

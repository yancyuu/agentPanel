<!-- markdownlint-disable MD013 -->

# Tasks: 独立私人工作台桌面应用

## Dependency Rule

> Phase 0 是硬门禁。Phase 0 全部完成前，不得开始 Phase 1–6 的实现代码。允许并行做只读设计和测试盘点，但不得提前修改 Electron、renderer 产品流程或 CLI 包边界。

## Phase 0: Split `src/main/server.ts` First

### Task 0.1: Inventory Routes And Shared State

- [x] 建立 235 个现有 Fastify routes 的路径、方法、所属领域和依赖清单
- [x] 列出所有顶层 stateful service、client、watcher、SSE set 和 runtime map
- [x] 标记 startup/shutdown ownership
- [x] 标记 teams/tasks/messages、auth、provider、review 和 Feishu 高风险路径
- [x] 记录 Phase 0 不允许变化的 HTTP contracts

### Task 0.2: Add Baseline Tests

- [x] 检查每个 route domain 的现有测试
- [ ] 为缺失的关键 route 注册和响应契约补测试
- [ ] 覆盖 teams/tasks/message ID 和状态映射
- [x] 覆盖 direct-cli/bridge 路由和事件写入
- [ ] 覆盖 setup/digital-worker 创建入口
- [ ] 覆盖 editor 路径安全
- [ ] 覆盖 extensions 基本路由
- [ ] 记录 telemetry 删除前的现有行为基线

### Task 0.3: Create Server Context

- [x] 新建 `ServerContext` 类型
- [x] 新建 `createServerContext()`
- [x] 收拢 `cc`、`bridge`、`bridgeLauncher` 和 `svc`
- [x] 收拢 extensions/system-manager/workflow services
- [x] 收拢 direct-cli、IM watcher 和 cc settings services
- [x] 收拢 update service、SSE clients 和 runtime maps
- [x] 为 context 增加明确的 shutdown/dispose contract
- [ ] 测试同一进程不会重复创建 stateful instances

### Task 0.4: Extract Small Route Domains

- [x] 抽取 version/update routes
- [x] 抽取 status routes
- [x] 抽取 app configuration routes
- [ ] 抽取 system-manager routes
- [ ] 抽取 notifications/events routes
- [ ] 每抽一个模块运行类型检查和聚焦测试

### Task 0.5: Extract Workbench Route Domains

- [ ] 抽取 setup/workers routes
- [ ] 抽取 editor routes
- [ ] 抽取 schedules routes
- [ ] 抽取 projects/dashboard/graph/context routes
- [ ] 抽取 extensions routes
- [ ] 每抽一个模块运行类型检查和聚焦测试

### Task 0.6: Extract High-Risk Route Domains

- [ ] 抽取 teams/tasks/messages routes
- [ ] 抽取 review/member/config routes
- [ ] 抽取 bridge/direct-cli routes和事件监听器
- [ ] 抽取 telemetry routes，暂时保持行为以便后续明确删除
- [ ] 验证消息 ID、`isMeta`、TaskRef 和软删除语义不变

### Task 0.7: Create Server Factory And Thin Entry

- [ ] 新建 `createWorkbenchServer(context, options)`
- [ ] route modules 只通过显式 context 获取依赖
- [ ] 独立 `startStandaloneServer()` 与 import side effects
- [ ] 统一 shutdown 顺序
- [ ] 将 `server.ts` 收缩到约 400 行以内
- [ ] 生成 route inventory 最终对照表

### Task 0.8: Phase 0 Verification Gate

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build:server` 通过
- [ ] 关键 route/domain 聚焦测试通过
- [ ] 确认无计划外 HTTP contract 变化
- [ ] 确认无重复 watcher/bridge/service 实例
- [ ] 确认启动和关闭无回归
- [ ] 只有以上全部完成后才解锁 Phase 1

## Phase 1: Create Independent Desktop App

### Task 1.1: Add Desktop Workspace Package

- [ ] 新建 `apps/workbench-desktop/`
- [ ] 更新 `pnpm-workspace.yaml`
- [ ] 添加 Electron main/preload/build 配置
- [ ] 配置 Windows x64 和 macOS arm64/x64 targets
- [ ] 保持 renderer Node integration 关闭和 context isolation 开启

### Task 1.2: Own Workbench Server Lifecycle

- [ ] Electron main 创建唯一 `ServerContext`
- [ ] Electron main 调用 `createWorkbenchServer()`
- [ ] server 只绑定 loopback
- [ ] 将实际 server URL 安全提供给 renderer
- [ ] 第二次启动聚焦已有实例
- [ ] app 退出时关闭 Fastify、watcher、bridge 和所属子进程

### Task 1.3: Reuse Existing Renderer

- [ ] 在桌面 app 中加载现有 Vite renderer
- [ ] 复用当前主题、组件和中文文案风格
- [ ] 保持 Extensions、Skills、设置、编辑器等二级页面可用
- [ ] 不进行 Multica 视觉复刻
- [ ] 添加桌面启动、空状态和错误恢复 smoke tests

## Phase 2: Move Workbench Out Of CLI

### Task 2.1: Define Shared Core Boundary

- [ ] 标记 CLI 三个保留领域使用的 application services
- [ ] 为 message bus 建立 CLI adapter
- [ ] 为 user/auth 建立 CLI adapter
- [ ] 为 token pool 建立 CLI adapter
- [ ] CLI adapters 不依赖 Fastify 或 Electron

### Task 2.2: Remove Workbench From CLI Package

- [ ] 删除 `web` CLI 启动入口
- [ ] 从 CLI 导航中删除工作台入口
- [ ] npm `files` 不再包含工作台 renderer 和 desktop assets
- [ ] CLI 不启动 Fastify 工作台 server
- [ ] 桌面 app 停止时验证保留 CLI 命令仍可用

## Phase 3: Private Activity Feature

### Task 3.1: Implement Domain Model

- [ ] 在 `src/features/private-activity/` 建立完整 feature slice
- [ ] 实现 Activity 状态机
- [ ] 实现 ExecutionRound 状态机
- [ ] 实现 comment-to-round policy
- [ ] 实现非法状态变化测试
- [ ] contracts 包含稳定 `agentId`

### Task 3.2: Implement Persistence And Application Use Cases

- [ ] 定义 Activity repository port
- [ ] 定义 Round dispatcher port
- [ ] 实现创建 activity + Round 1
- [ ] 实现原子或 outbox 型 comment + next round
- [ ] 实现 client mutation id 幂等
- [ ] 实现 retry 为新 round，不覆盖历史
- [ ] 实现重启恢复测试

### Task 3.3: Implement Activity HTTP Adapters

- [ ] 创建 activity routes
- [ ] 创建 comment/next-round route
- [ ] 创建 timeline route
- [ ] 创建 inbox projection route
- [ ] 校验输入并优雅映射错误

### Task 3.4: Implement Current-Style Renderer UI

- [ ] 新增私人动态列表
- [ ] 新增发布任务入口
- [ ] 新增动态详情和 round 时间线
- [ ] 新增评论输入框
- [ ] 新增等待用户/完成/失败收件箱筛选
- [ ] 复用当前 UI 组件和设计 token
- [ ] 新增中文空状态、失败和重试文案

## Phase 4: Feishu Personal Authorization

### Task 4.1: Preserve Identity Invariants

- [ ] 非飞书渠道不触发授权
- [ ] 飞书渠道使用真实 lark-cli profile
- [ ] 强制个人 `as user`
- [ ] 强制完整 `--domain all`
- [ ] 明确禁止 bot/app token 和 AgentBus auth token 替代

### Task 4.2: Integrate Desktop Creation Flow

- [ ] 创建流程检测 lark-cli
- [ ] 显示授权用途和状态
- [ ] 支持成功、失败、取消和重试
- [ ] 授权失败时在团队/渠道创建前停止
- [ ] 授权成功后继续数字员工创建
- [ ] 支持重新授权路径

### Task 4.3: Preserve Credential Reporting

- [ ] 飞书授权成功后触发凭证上报
- [ ] 凭证上报失败可安全重试
- [ ] 不在 renderer 或日志中暴露 token
- [ ] 用测试证明凭证上报不依赖 usage telemetry

## Phase 5: Remove Usage Telemetry

### Task 5.1: Remove Runtime Behavior

- [ ] 删除 usage CLI commands
- [ ] 删除 `__telemetry-worker`
- [ ] 删除 usage worker 启停和自动启动逻辑
- [ ] 删除 usage 定时上报
- [ ] 删除 usage status/export/report routes
- [ ] app 和 CLI 启动 smoke 证明没有 telemetry worker

### Task 5.2: Preserve Unrelated Reporting

- [ ] 保留飞书授权凭证上报
- [ ] 保留必要的本地日志但不采集 usage
- [ ] 检查 package 和安装包中无 telemetry worker 入口

## Phase 6: Windows And macOS First Release

### Task 6.1: CI Packaging

- [ ] Windows runner 构建 x64 installer
- [ ] macOS runner 构建 arm64 installer
- [ ] macOS runner 构建 x64 installer
- [ ] 上传安装包和校验信息
- [ ] 首版不阻塞于签名、公证和自动更新

### Task 6.2: Cross-Platform Runtime Verification

- [ ] Windows PATH/runtime discovery
- [ ] macOS PATH/runtime discovery
- [ ] lark-cli 检测和授权启动
- [ ] Claude Code/Codex runtime readiness
- [ ] app 数据目录和日志目录
- [ ] app 退出后无残留进程

### Task 6.3: Release Acceptance

- [ ] Windows 安装、启动、创建任务、评论下一轮
- [ ] macOS arm64 安装、启动、创建任务、评论下一轮
- [ ] macOS x64 构建 smoke
- [ ] 飞书个人授权成功和失败路径
- [ ] CLI 独立运行验证
- [ ] usage telemetry 缺失验证

## Phase 7: Deferred Hardening

- [ ] Windows 代码签名
- [ ] macOS signing/notarization
- [ ] 自动更新
- [ ] 完整多智能体指派和并行执行
- [ ] 视觉系统重设计

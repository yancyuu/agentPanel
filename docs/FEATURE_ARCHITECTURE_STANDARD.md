# Feature Architecture Standard

**状态**：团队标准
**参考实现**：`src/features/recent-projects`

本文定义 openHermit 中大型功能的默认代码组织方式。当前产品是 Fastify API + Vite Web UI + cc-connect Bridge，本标准优先服务浏览器工作台和本地优先后端；不要按 Electron 桌面应用假设设计新功能。

## 目标

- 把业务规则和运行时细节隔离。
- 让功能更容易测试、迁移和 review。
- 让 renderer 代码保持浏览器友好。
- 用 lint 和 public entrypoint 约束边界，而不是只靠口头约定。

## 标准目录

```text
src/features/<feature-name>/
  contracts/
  core/
    domain/
    application/
  main/
    composition/
    adapters/
      input/
      output/
    infrastructure/
  preload/
  renderer/
```

新功能满足以下任一条件时，优先使用完整 slice：

- 跨越 renderer / Fastify / runtime bridge 边界。
- 有自己的 use case、状态机、合并策略或过滤规则。
- 需要独立 HTTP route、WebSocket、cc-connect、MCP 或外部存储适配。
- 预计会继续扩展 provider、source、channel 或 UI 流程。

纯展示、小改动或只重排已有数据的功能可以使用 thin slice。

## 分层职责

### `contracts/`

跨边界公共 API。

允许：

- DTO
- route 常量
- API fragment 类型
- 可序列化枚举和错误码

禁止：

- store 访问
- Fastify / React / Node runtime 调用
- 业务编排

### `core/domain/`

纯业务规则和不变量。

示例：

- 状态机
- 去重规则
- merge policy
- provider-agnostic model
- 权限或白名单判定

禁止：

- 文件系统、网络、数据库、Redis
- Fastify、React、Zustand、cc-connect
- child process 或 shell 调用

### `core/application/`

Use case 和 port。

示例：

- 创建团队、派发任务、绑定渠道等应用流程
- repository / gateway / bridge port
- response model
- 错误映射

禁止：

- Fastify 实例
- React / Zustand
- 具体文件路径、Redis client、cc-connect client、child process

### `main/composition/`

后端 composition root。

职责：

- 实例化 infrastructure
- 连接 adapters 和 use cases
- 向 `src/main/server.ts` 或上层 shell 暴露小 facade

### `main/adapters/input/`

Driving adapter。

示例：

- Fastify route registration
- WebSocket handler
- MCP/CLI command adapter

职责：

- 校验 transport input
- 转成 use case command/query
- 把 use case 结果转成 HTTP/WebSocket 响应

### `main/adapters/output/`

Driven adapter。

示例：

- presenter
- repository adapter
- cc-connect gateway adapter
- Redis task bus adapter

职责：

- 实现 application port
- 转换外部数据和 core model
- 保持薄封装，复杂规则回到 core

### `main/infrastructure/`

具体技术实现。

示例：

- `~/.hermit` 文件读写
- Redis client
- cc-connect Bridge / Management API client
- git / worktree helper
- runtime discovery
- cache

职责：

- 处理 OS、协议、网络、文件、进程等细节
- 不承载业务状态机

### `preload/`

保留给需要 shell bridge 的场景。当前 openHermit 主要是 Web UI + HTTP API，新功能不要为了凑模板强行添加 preload。

允许：

- 暴露极薄的 API fragment
- 依赖 `contracts/`

禁止：

- 业务编排
- renderer 状态
- main composition 细节

### `renderer/`

展示和交互。

推荐结构：

```text
renderer/
  index.ts
  adapters/
  hooks/
  ui/
  utils/
```

职责：

- `ui/` 只渲染 props 和触发事件
- `hooks/` 编排交互、store 和 API 调用
- `adapters/` 把 DTO 转成 view model
- `utils/` 放纯 renderer helper

## Import 规则

### 只从 public entrypoint 引入

feature 外部只能引入：

- `@features/<feature>/contracts`
- `@features/<feature>/main`
- `@features/<feature>/preload`
- `@features/<feature>/renderer`

不要从 app shell 或其它 feature deep import 内部文件。

### Core 隔离

`core/domain` 不得 import：

- `@main/*`
- `@renderer/*`
- `@preload/*`
- adapters
- infrastructure
- Fastify
- React / Zustand
- Node process / child process

`core/application` 不得 import：

- `main/*`
- `renderer/*`
- Fastify instance
- React / Zustand
- 具体 Redis、文件系统、cc-connect client

### UI 隔离

`renderer/ui` 不得 import：

- `@renderer/api`
- `@renderer/store`
- `@main/*`
- Node / Electron API

把 API、store、bridge 访问放到 feature hook 或 adapter。

## 当前产品边界

新文档和新功能要按以下事实设计：

- 当前工作台是 Fastify + Vite，不是 Electron 桌面打包。
- 当前没有内嵌 PTY；终端能力不要写成 renderer 内终端。
- 默认数据目录是 `~/.hermit/`。
- 团队页是核心入口，默认路由是 `/teams`。
- runtime 和外部渠道通过 cc-connect Bridge / Management API 接入。
- 团队工作区围绕 team、task、message、project workspace 组织。
- worktree 是当前团队成员隔离能力。
- 跨团队协作当前是 Redis-backed dispatch；完整 Task Bus 是目标模型。

## 浏览器友好方向

默认 transport 方向：

```text
renderer -> feature contracts -> renderer API adapter -> Fastify route -> use case
```

保持这条路径清晰：

- UI 不直接访问 `window.electronAPI` 或 Node API。
- renderer 通过统一 API adapter 调后端。
- 业务规则留在 `core/`。
- Fastify、Redis、cc-connect、文件系统都留在 `main/`。

## Thin Slice 规则

可以跳过 `core/`、`main/`、`preload/` 的情况：

- 只做展示组件。
- 只组合已有 API 数据。
- 不增加新状态机、存储或 transport。
- 不引入 runtime、channel、Task Bus、worktree 等边界。

如果功能有有意义的纯语义或投影规则，至少保留 `core/domain`。

## Definition of Done

一个 reference-quality feature 应满足：

- 目录结构匹配本标准或明确说明 thin slice 原因。
- core 无副作用。
- app shell 只引 public entrypoint。
- renderer UI 保持 presentational。
- route / adapter / repository 职责清晰。
- 中大型功能至少覆盖 domain 和 application 规则测试。
- 新边界有简短文档或 plan。

## 推荐测试覆盖

中大型功能至少覆盖：

- domain policy
- application use case
- renderer interaction utility
- adapter mapping

## 参考实现

### Recent Projects

`src/features/recent-projects` 是完整 slice 参考。

适合参考：

- contracts ownership
- core/application separation
- composition root wiring
- renderer dumb UI + hook orchestration
- browser-friendly transport
- lint guard rails

### Agent Graph

`src/features/agent-graph` 是 thin slice 参考。

适合参考：

- 把纯图语义放在 `core/domain`
- 暴露 renderer-only public entrypoint
- 集成 `packages/agent-graph` 时不虚构进程层
- 从旧 `src/renderer/features/*` 迁移到 canonical feature root

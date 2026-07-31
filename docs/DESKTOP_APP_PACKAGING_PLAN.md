# AgentCLI 桌面客户端封装方案

## 目标

用户只安装一个桌面客户端即可打开工作台、创建智能体、执行任务和使用小队协作，不需要预先安装 Node.js、pnpm 或 AgentCLI。

客户端内部继续保留 HTTP/SSE 与 CLI 作为运行架构，但普通用户不接触端口、进程、命令行和运行时目录。

## 技术选择

采用 Electron，而不是把现有 Web 工作台重写成原生界面。

原因：

- Renderer 已经是完整的 React/Vite 应用。
- 后端是 Node.js/Fastify，并依赖本地进程、文件系统和 CLI 调度。
- Electron 自带 Node.js 运行时，可以直接托管现有服务。
- 现有 `build:web`、`build:server` 和 `build:standalone` 可以复用。

## 安装包内置内容

```text
AgentCLI.app/
  Contents/
    MacOS/
      AgentCLI                    # Electron 主程序
    Resources/
      app.asar                    # Electron 主进程与桌面壳
      agentcli/
        dist/server.bundle.mjs    # 内置 Fastify 服务
        dist-renderer/            # Web 工作台静态资源
        bin/agentcli.mjs          # 内置 AgentCLI 命令入口
        vendor/cc-connect/        # 兼容 sidecar
        node_modules/             # 仅保留运行必需依赖
```

用户不需要单独执行 `npm install -g`、`pnpm add -g` 或安装 Node.js。

## 运行架构

```text
Electron 主进程
  ├─ 获取单实例锁
  ├─ 启动内置 AgentCLI/Fastify 服务
  ├─ 等待 /api/health 可用
  ├─ 创建 BrowserWindow
  ├─ 加载 127.0.0.1 的工作台
  └─ 退出时终止内置服务

React Renderer
  └─ 继续通过 HTTP + SSE 使用现有 API

内置 AgentCLI
  ├─ 任务总线
  ├─ 智能体与小队编排
  ├─ 本地文件与成果归档
  └─ 调用已配置的模型运行时
```

## 服务生命周期

1. 客户端启动时申请单实例锁。
2. 优先使用客户端专属的空闲 loopback 端口；不把端口暴露给用户。
3. 通过 Electron 的 Node 运行能力启动 `server.bundle.mjs`。
4. 在显示主窗口前轮询健康检查，超时则显示人类可读的修复页。
5. 主窗口关闭后按设置选择退出或留在托盘。
6. 应用退出时终止服务和所有由本次客户端启动的子进程。
7. 用户数据继续保存在 `~/.hermit/`，保证桌面端和可选 CLI 入口共享同一份任务、智能体和成果。

## AgentCLI 命令的内置方式

### 客户端内部

应用内部始终使用安装包中的 AgentCLI，不查询全局 npm 安装，也不要求修改 PATH。

### 用户终端（可选）

设置页提供“安装命令行入口”按钮，将一个轻量启动器写入：

```text
~/.hermit/bin/agentcli
```

启动器读取客户端每次启动时更新的资源位置，再调用安装包内的 AgentCLI。这个入口是可选能力；普通用户不安装也能使用全部工作台功能。

不应静默修改用户的 Shell 配置。若 `~/.hermit/bin` 不在 PATH，只展示一次可复制的配置说明。

## 模型运行时边界

内置 AgentCLI 解决的是工作台、任务总线、本地服务和命令入口的安装问题。

当前智能体执行仍依赖已支持的模型运行时及其账号授权。客户端需要提供首启向导：

- 自动检测可用运行时。
- 引导用户登录或授权。
- 不向普通用户展示二进制路径和环境变量。
- 运行时缺失时给出“一键安装/登录”或清晰的人类提示。

如果第三方运行时的许可证允许再分发，后续可将其加入安装包；在许可证未确认前，不应直接打包第三方受限 CLI。

## 安全边界

- 服务只监听 `127.0.0.1`。
- 每次启动生成桌面会话令牌，窗口请求自动携带。
- 不接受任意远程 Origin。
- 文件选择继续通过受限的任务附件 API，不向 Renderer 暴露任意文件系统能力。
- Electron 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 客户端只终止自己启动并记录 PID/session 的进程。

## 构建与发布

第一阶段只交付 macOS Apple Silicon：

```text
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:dist:mac
```

产物：

```text
dist-desktop/AgentCLI-<version>-arm64.dmg
```

后续增加 macOS x64/universal、Windows NSIS 和 Linux AppImage。

## 验收标准

- 全新机器无需 Node.js、pnpm 和全局 AgentCLI。
- 安装一个 `.dmg` 后可直接打开客户端。
- 客户端自动启动本地服务并显示工作台。
- 退出客户端后不会残留本次启动的服务进程。
- 重启客户端后仍能读取 `~/.hermit/` 中的智能体、任务和成果。
- 收件箱、单智能体任务、小队任务、返工和成果归档正常。
- 可选命令入口可以执行 `agentcli tasks list`，且与客户端读取同一份数据。
- 缺少模型运行时或授权时，客户端显示可操作的首启引导，而不是终端错误。

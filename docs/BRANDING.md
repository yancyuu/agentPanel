# AgentPanel 品牌与兼容标识

## 正式产品名称

- 产品展示名：**AgentPanel**
- CLI 命令：`agentpanel`
- npm 包：`@yancyyu/agentpanel`
- GitHub 仓库：`yancyuu/agentpanel`

新增的页面标题、导航、错误提示、日志说明、Prompt 注入和当前产品文档统一使用 `AgentPanel`。不要再以 `Hermit`、`openHermit` 或 `AgentPanel` 作为用户可见产品名称。

## 内置运行时

AgentPanel 是 Workbench 内置的 Agent 运行时与协议客户端。用户不需要单独全局安装 AgentPanel；Web 服务或桌面应用负责提供与 Workbench 同版本的 CLI，并向其启动的 Agent 子进程注入受管 PATH。

Loop、任务看板和团队协作是建立在 AgentPanel 命令与 Workbench API 之上的功能模块。Agent 通过普通 Shell 调用 `agentpanel ...`，不使用 MCP、Skills 或 Harness 原生任务工具维护协作状态。

## 向后兼容标识

以下名称已经进入本地数据、环境变量、外部 API、OAuth、会话键或历史配置。品牌迁移期间必须继续读取或保留 alias，不能作为普通文案批量替换：

- `HERMIT_HOME`、`HERMIT_*`、`OPENHERMIT_*`
- 默认数据目录 `~/.hermit/`
- `auth/openhermit.json`、`openhermit.pid` 及旧日志文件名
- `hermit-bridge`、`HermitBridge*` 兼容类型和旧目录
- `/api/hermit-config*`、`/api/hermit-bridge-config*`
- `/oauth/openhermit/callback`
- `hermit:*`、`bridge:hermit-*` 等历史会话或命令命名空间
- `hermit-team.json`、现有 HermitTeams 模板仓库 URL
- `<!-- hermit:* -->` 托管内容标记
- `hermit-tasks`、`hermit-workbench` 等历史能力 ID

新增代码应优先使用品牌中立或 AgentPanel 命名；旧标识只用于兼容读取、迁移、停止旧进程和解析历史数据。

## 迁移原则

1. 用户可见品牌直接统一为 AgentPanel。
2. 外部契约先增加新入口或中立 alias，再切换调用方。
3. 本地状态目录采用兼容发现，不能强制搬迁后删除旧目录。
4. 环境变量采用新值优先、旧值回退，并在至少两个稳定版本内保持双读。
5. 历史 changelog、日期化设计记录和兼容测试可以保留旧名称，但必须明确其历史或兼容性质。

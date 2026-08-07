# AgentPanel 文档索引

本目录记录 AgentPanel 当前产品、架构和发布流程。版本事实以根目录 `package.json` 为准。

## 当前产品事实

- 产品形态：Fastify API + Vite Web UI
- 默认入口：`/teams`
- 默认数据目录：`~/.hermit/`
- 分发方式：npm CLI package，包名 `@yancyyu/agentpanel`
- 运行时桥接：hermit-bridge / Management API
- 团队工作区：team、task、message、project workspace
- 隔离能力：团队成员可使用独立 worktree
- 渠道边界：AgentPanel 做团队路由、白名单和审计；平台 Bot 适配由 hermit-bridge 承载
- 跨团队派单：当前是 Redis-backed dispatch；完整 Task Bus 是目标模型
- 当前不提供：Electron 桌面安装包、内嵌 PTY 终端

## 主要文档

| 文档 | 内容 |
|:---|:---|
| [../README.md](../README.md) | 产品介绍、快速开始、能力边界 |
| [BRANDING.md](BRANDING.md) | AgentPanel 正式品牌与历史兼容标识边界 |
| [FEATURE_ARCHITECTURE_STANDARD.md](FEATURE_ARCHITECTURE_STANDARD.md) | 中大型 feature 的代码组织标准 |
| [specs/agentpanel-cli.md](specs/agentpanel-cli.md) | AgentPanel 命令行与本地运行时规范 |
| [TEAM_COLLABORATION_MODEL.md](TEAM_COLLABORATION_MODEL.md) | Agent、Leader、成员范围与 CLI-only 团队协作模型 |
| [team-management/README.md](team-management/README.md) | 团队、渠道、Task Bus 的 canonical 架构入口 |
| [team-management/cross-team-collaboration.md](team-management/cross-team-collaboration.md) | 跨团队消息与 Redis dispatch 工作流 |
| [RELEASE.md](RELEASE.md) | npm / GitHub / Docker 发布流程 |
| [CHANGELOG.md](CHANGELOG.md) | 用户可见变更记录 |

## 历史资料

`docs/team-management/` 下的 research / plan 文件保留为历史研究材料。若历史文档与当前代码、README 或 team-management canonical 文档冲突，以当前代码和 canonical 文档为准。

## 写文档时的边界

- 不把目标模型写成已发布能力。
- 不写 Electron 打包说明，除非当前 workflow 已重新支持。
- 不写内嵌终端或 PTY 能力；当前产品倾向打开系统终端或通过 runtime bridge 执行。
- 描述渠道时区分 AgentPanel 控制面和 hermit-bridge 平台适配。
- 描述 Task Bus 时区分当前 Redis dispatch 和目标 offer / bid / lease / event 模型。

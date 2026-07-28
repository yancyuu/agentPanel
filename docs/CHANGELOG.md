# Changelog

本文件记录 openHermit 的用户可见变化。项目遵循 Semantic Versioning。

## [Unreleased]

## [1.10.0] - 2026-07-28

### Added

- 用量采集与消息上报新增 Pi 支持：扫描 `~/.pi/agent/sessions/**/*.jsonl`，统计 input/output/cache read/cache write token，并支持 `agentcli usage start --upload --provider pi`。
- Pi clone/fork 会话使用稳定消息指纹去重，避免复制历史 entry 导致本地统计和服务端上报重复。

### Changed

- 默认消息上报来源扩展为 Claude Code、Codex 和 Pi；已显式关闭消息上报的配置继续保持关闭。
- 用量状态、CLI 表格和 Web 用量面板现在分别展示 Pi 的 session、消息和 token 汇总。

### Fixed

- 修复多来源并行上报中某一来源失败后提前释放上传锁、其余来源仍在后台发送的问题。
- 修复显式关闭消息上报时可能被旧版嵌套配置重新开启的问题。
- 修复更新检查和崩溃报告仍指向旧 GitHub 仓库的问题。
- 修复用量测试读取开发机真实 Codex/Pi 会话以及批次环境状态导致的顺序依赖。

## [1.9.80] - 2026-07-28

### Changed

- AgentCli 终端的「工作台」菜单不再提供「开通数字员工」快捷向导；数字员工创建和管理统一引导到 Web 工作台。底层 `create-digital-worker` 命令暂时保留，兼容已有脚本和自动化流程。

### Fixed

- ESLint 现在能正确解析 `bin/` 和 `test/` 下的 JavaScript/MJS 测试，并移除了配置中的重复规则键。

## [1.9.32] - 2026-07-22

### Added

- token 池认领新增 `Pi` 渠道：选 Pi 后把网关 key + codex 入口（cpamc-openai + `openai-responses`）+ 全部已授权模型写入 `~/.pi/agent/models.json` 的 `skg` provider（把旧的 `cpamc-openai-v2` / completions 更新为新契约），其他 pi provider 保持不变。Codex / Claude / Pi 三渠道认领后均使用同一把下发的 key。

## [1.9.31] - 2026-07-21

### Fixed

- 修复后台遥测扫描、跨团队状态同步等 fire-and-forget 异步任务在瞬时 IO 失败时会导致整个服务进程崩溃的问题（新增全局 `unhandledRejection` 兜底，并为遥测扫描与状态同步补上 `.catch`）。
- 修复 worker-society 持久化的原子写使用固定临时文件名、并发写覆盖丢数据的问题。

### Changed

- 适配阿里云 AI 网关 token 分发 v3 新契约（74abdbf）：消费者回执的 `runtime_profiles` 成为各运行时入口地址的权威来源，`endpoints` / `models_url` 仅作向后兼容；认领时优先从 `runtime_profiles` 解析 codex / claude 的 base_url，避免在未交付对应角色时拼出不存在的入口。

## [1.9.30] - 2026-07-21

### Security

- Web 服务默认只监听本机回环地址（`127.0.0.1`），不再默认暴露到局域网；并对全部路由统一校验来源，堵住恶意网页跨源调用本地服务执行命令、读写文件的风险。
- hermit-bridge 的 management / bridge token 在配置接口返回时掩码显示；编辑器根目录拒绝文件系统根、用户主目录、`.ssh`、`.hermit` 等敏感目录。

### Fixed

- 修复跨团队任务设置「免审核」后仍卡在待审核状态的问题：`needsHumanReview=false` 现在会在交付后自动通过。
- 修复带账号密码的 Redis URL（如 `redis://user:pass@host:6379`）导致 host 非法、团队总线始终连不上的问题。
- 修复回复消息对中文成员名解析失败、结构化回复退化为纯文本的问题。
- 修复 HTTP 响应中形如 ISO 日期的文本被误转成 Date 对象、可能导致消息分类错误或渲染崩溃的问题。
- 含 token 的配置文件改为原子写入，避免写入中途崩溃后配置损坏。

### Changed

- token 池认领等待签发时改用单行 spinner 显示实时状态与已等待时间，不再每 2 秒清屏重绘；Windows 下不再出现中文乱码刷屏。全平台统一使用 braille 转圈样式（`HERMIT_SPINNER_ASCII=1` 可降级为 ASCII）。

## [1.9.13] - 2026-07-14

### Changed

- token 池认领改为直接写入所选 Claude Code / Codex 配置；不再修改 shell 启动文件或安装 `precmd` / `PROMPT_COMMAND` hook，`~/.hermit/aikey.env` 仅供外部 agent 按需手动加载。
- token 池选择运行时后统一要求选择模型：仅写入 Claude Code 时也不再静默使用 receipt 中的首个模型，所选模型同时用于 Claude 的 haiku / sonnet / opus tier，并在选择 Codex 时写入 Codex 配置。
- 「工作台 → 开通数字员工」升级为最小化快速创建流程：飞书/Lark 请求 lark-cli 当前支持的全量个人授权，并在终端显示二维码、同时尝试打开浏览器。
- Lark 凭证上报扩展为完整个人授权信息，除 app/token 外同步用户 open_id、scope 与 access/refresh token 过期时间，便于服务端准确判断授权主体和有效期。
- 重写 README 与公开站点为「开源 + 企业版」双产品说明书：AgentCli 开源免费（AGPL-3.0），AgentBus 定位为付费企业增值服务；合并首页与使用指南为单页，补齐 token 池认领（直写 Claude/Codex 配置）与用量上报三要素说明。
- 将公开文档更新为当前 openHermit 产品面：Fastify API、Vite Web UI、默认 `/teams` 工作台、`~/.hermit/` 本地优先存储，以及 `@yancyyu/agentcli` 当前包事实。
- 统一 README、文档索引、团队架构、跨团队协作和发布指南中的 Loop Engineering 叙述。
- 明确 cc-connect Bridge 边界：Hermit 负责团队路由、渠道绑定、白名单和审计；平台 Bot 适配由 cc-connect 承载。
- 明确团队工作区由 team、task、message 和 project workspace 组成，并记录 worktree 隔离是当前并行协作能力。
- 明确跨团队协作当前是 Redis-backed dispatch，完整 offer / bid / lease / event Task Bus 是目标模型。
- 更新 Feature Architecture Standard，使新功能默认面向 Fastify/Vite/Web 工作台，而不是 Electron 桌面假设。
- 更新 Release Guide，聚焦 npm CLI package、GitHub Release，以及当前 Docker/GHCR workflow 对 `docker/Dockerfile` 的前置要求。

### Fixed

- 修复 token 池仅选择 Claude Code 时仍显示 Codex model 缺失警告的问题；未选择的运行时不再产生误导性告警。
- 自动修复旧版本遗留的配置备份清单路径，确保备份状态与当前 `~/.hermit/agentcli.env.bak` 位置一致。

### Added

- 新增 `docs/README.md` 文档索引，集中列出当前产品事实、主要文档和写作边界。

### Removed

- 从当前能力文档中移除 Electron 桌面打包和内嵌 PTY 终端表述；这些只作为历史说明保留。

## [1.0.0] - 2026-03-19

Initial public release.

### Added

- `general.autoExpandAIGroups` setting: automatically expands all AI response groups when opening a transcript or when new AI responses arrive in a live session. Defaults to off. Stored in the on-disk config so it persists across restarts.
- Strict IPC input validation guards for project/session/subagent/search limits.
- `get-waterfall-data` IPC endpoint implementation.
- Cross-platform path normalization in renderer path resolvers.
- `onTodoChange` preload API event bridge.
- CI workflow for macOS/Windows (typecheck, lint, test, build).
- Release workflow for signed package builds.
- Open-source governance docs (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`).
- Capped NDJSON diagnostic log for Claude CLI auth/status in packaged builds (Electron logs directory).

### Changed

- `readMentionedFile` preload API signature now requires `projectRoot`.
- Notification update event contract standardized to `{ total, unreadCount }`.
- Session pagination uses cached displayable-content detection for performance.
- File watcher error detection optimized for append-only updates.
- CLI status gathering uses interactive shell environment, merged PATH, and config directory hints aligned with terminal sessions.
- Claude binary resolution deduplicates concurrent resolve calls and uses consistent HOME when probing install locations.

### Fixed

- Lint violations in navigation and markdown/subagent UI components.
- Test mock drift causing runtime errors in test output.
- Multiple Windows path handling edge cases.
- Packaged builds could show "not logged in" despite a working CLI in the shell.
- IPC CLI installer cache clears when `getStatus` fails so the UI does not stay on stale auth state.

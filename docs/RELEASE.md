# Release Guide

本文记录 `yancyuu/agentcli` 当前发布流程。当前包名是 `@yancyyu/agentcli`，版本事实以根目录 `package.json` 为准。

## 当前发布事实

| 项 | 当前值 |
|:---|:---|
| Repository | `https://github.com/yancyuu/agentcli` |
| npm package | `@yancyyu/agentcli` |
| CLI binary | `agentcli` |
| Web build | `pnpm build:web` |
| Release workflow | `.github/workflows/release.yml` |
| Standalone assets | Windows x64、macOS x64、macOS arm64、Linux x64 |
| Docker image | 当前未启用；仓库没有 `docker/Dockerfile` |
| 产品形态 | Fastify API + Vite Web UI |
| 默认入口 | `/teams` |
| 默认数据目录 | `~/.hermit/` |

当前没有 Electron 桌面安装包发布流程，也没有内嵌 PTY 相关产物。GitHub Release 会构建四个平台的自包含 standalone ZIP；旧 release note 中的桌面安装包名称只属于历史版本。

## 版本号

使用 SemVer：`MAJOR.MINOR.PATCH`。

| 类型 | 适用场景 | 示例 |
|:---|:---|:---|
| MAJOR | 破坏 CLI、HTTP API、存储或 runtime 行为 | `1.6.42` → `2.0.0` |
| MINOR | 新面板、新 runtime、新渠道、新工作流 | `1.6.42` → `1.7.0` |
| PATCH | Bug fix、文档、兼容性和体验修正 | `1.6.42` → `1.6.43` |

## 发布前检查

从干净分支开始，避免把 release 修改和无关功能混在一起。

```bash
git status --short
pnpm install
pnpm typecheck
pnpm test
pnpm build:web
```

如果工作树里有无关修改导致检查不可运行，必须在 release 说明里写明。

## 更新版本

```bash
pnpm version <major|minor|patch> --no-git-tag-version
pnpm install --lockfile-only
```

检查版本和文档 diff：

```bash
git diff -- package.json pnpm-lock.yaml README.md docs/README.md docs/CHANGELOG.md docs/RELEASE.md
```

发布前必须更新 `docs/CHANGELOG.md`，从用户视角描述变化。

## GitHub Release

当前 GitHub release workflow 由 tag 触发。Tag 使用纯 semver，例如 `1.10.0`。Tag 推送后会创建 GitHub Release，并在原生 runner 上构建 Windows x64、macOS x64、macOS arm64 和 Linux x64 standalone ZIP。

```bash
git tag <VERSION>
git push origin <VERSION>
```

也可以手动创建 release notes：

```bash
gh release create "$VERSION" \
  --repo yancyuu/agentcli \
  --title "$VERSION" \
  --generate-notes \
  --draft=false
```

当前 workflow 已移除 Docker job，因为仓库没有 `docker/Dockerfile`。需要恢复 GHCR 发布时，应先补齐容器构建文件和验证流程；npm 与 standalone 发布不依赖 Docker。

## npm 发布

当前 workflow 不自动发布 npm。GitHub Release 准备好后手动发布。

```bash
pnpm build:web
pnpm pack
pnpm publish --access public
```

发布后验证：

```bash
npm view @yancyyu/agentcli version
npx @yancyyu/agentcli@latest --version
```

## Release notes 模板

```markdown
## AgentCLI <VERSION>

<用 1-2 句话说明本次发布。>

### 新增

- <用户可见能力>

### 改进

- <用户可见改进>

### 修复

- <用户可见修复>

### 升级说明

- <用户或运维必须采取的动作；没有则省略>
```

## Changelog 规则

写用户能理解的结果，不写内部实现流水账。

推荐：

- “新增团队渠道绑定白名单，限制外部群聊访问指定团队。”
- “修复 Redis task bus 未配置时跨团队派单提示不清晰的问题。”
- “改进 `/teams` 工作台的团队详情加载体验。”

避免：

- “Refactor TaskDispatchService。”
- “Update dependencies。”
- “Fix useEffect cleanup。”

分组顺序：

1. 新增
2. 改进
3. 修复
4. 移除
5. Breaking Changes
6. 升级说明

## 文档同步要求

以下变化必须同步 README、docs index、release note 或相关架构文档：

- runtime adapter 变化。
- cc-connect setup、Bridge 或 Management API 变化。
- 外部平台、渠道绑定、白名单或 session key 路由变化。
- `/teams`、团队详情、任务、消息工作区变化。
- worktree 隔离行为变化。
- Redis-backed dispatch 或 Task Bus 语义变化。
- 默认数据目录、CLI 命令、端口或路由变化。
- 截图变化。

写渠道能力时必须区分：AgentCLI 控制面能力、cc-connect 平台适配能力、目标能力。不要把平台列表写成 AgentCLI 内置 Bot。

写 Task Bus 时必须区分：当前 Redis-backed dispatch 和目标 offer / bid / lease / event 模型。

## Standalone 发布检查

Tag 推送后检查 workflow，并确认四个 ZIP 都已上传：

```bash
gh run list --repo yancyuu/agentcli --workflow release.yml --limit 3
gh release view <VERSION> --repo yancyuu/agentcli
```

必须包含：Windows x64、macOS x64、macOS arm64、Linux x64。

## 删除或修复 release

```bash
gh release delete <VERSION> --repo yancyuu/agentcli --yes
git tag -d <VERSION>
git push origin :refs/tags/<VERSION>
```

只有公开 release 明确损坏时才删除。普通问题优先发 patch release。

## 历史说明

旧版本可能提到 Electron 桌面安装包、签名产物或 `Claude.Agent.Teams.UI-*` 之类 artifact。当前仓库发布主线是 npm CLI package + GitHub Release standalone ZIP；Docker/GHCR 当前未启用。只有在当前 workflow 重新支持桌面或容器产物后，才恢复对应打包说明。

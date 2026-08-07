---
id: "doctor"
label: "Doctor"
description: "诊断 AgentPanel、Claude Code、hermit-bridge 和 Loop runtime 健康。"
category: health
safety: read-only
order: 20
filename: "doctor.md"
---
<!-- hermit-builtin-workflow:v2-loop -->
# Loop Runtime Doctor — 环境与循环运行时诊断

你是 AgentPanel 运维诊断助手。请检查当前环境是否适合运行长期 Agent loop。


## 安全边界

- 默认只读分析：不要修改、删除、移动、格式化、提交、推送、发布或部署任何文件。
- 不要运行 destructive 命令；需要命令时先说明目的，优先使用只读命令。
- 不要泄露 secrets、token、cookie、私钥或完整敏感路径。
- 如果发现需要修复的问题，只输出建议、验证步骤和可选 patch 计划，不要直接 apply。
- 输出报告时请标注证据来源、风险等级和下一步建议。


## 基础环境

- 操作系统、内存、磁盘、文件描述符限制
- `claude` 是否可用、版本、登录状态
- hermit-bridge / AgentPanel 服务是否运行
- 当前工作区路径是否正确


## Loop Engineering 资产扫描范围

请优先检查这些资产是否存在、是否过期、是否冲突、是否值得沉淀成循环：

- 自动化：`.github/workflows/`、package scripts、cron/schedules、hooks、`/loop` 或 goal 类配置
- 工作树：`.claude/worktrees/agent-*`、git worktree 列表、分支/dirty 状态、陈旧 agent 工作区
- 技能：`.claude/skills/`、`.hermit/skills/`、`~/.claude/skills/` 的项目相关 skill
- 插件/连接器：`.cursor/mcp.json`、`.claude/settings*.json`、MCP/plugin 配置、`src/main/services/extensions/**`
- 子 Agent：`.claude/agents/`、team manifests、agent teams、subagent tracking
- 状态：`.omc/state/`、`.omc/sessions/`、reports、tasks、last-tool-error、mission/setup state
- 指令层：`CLAUDE.md`、`AGENTS.md`、`.claude/commands/`、`workflows/`


## Loop runtime 重点诊断

- `.claude/commands` 是否包含 loop 相关命令，是否和 `workflows/` 重复
- `.claude/worktrees/agent-*` 是否过多、过旧、dirty
- `.omc/state/subagent-tracking.json` 和 `.omc/state/last-tool-error.json` 是否显示异常
- MCP/plugin/connector 配置是否存在明显缺失或 secret 风险
- 是否存在没有停止条件的循环、无人值守 apply、自动 commit/push/deploy 风险

## 输出

请输出诊断报告：正常项、警告项、异常项、证据路径、建议动作。不要修复问题。


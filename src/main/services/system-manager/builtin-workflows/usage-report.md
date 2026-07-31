---
id: "usage-report"
label: "Usage Report"
description: "汇总会话、子 Agent、工作树和循环吞吐线索。"
category: usage
safety: reporting
order: 40
filename: "usage-report.md"
---
<!-- hermit-builtin-workflow:v2-loop -->
# Loop Usage Report — 循环吞吐报告

你是 AgentCLI 的循环吞吐分析助手。请分析当前工作区的 agent/session/worktree/state 使用情况，判断哪些循环花费大、停滞、重复，哪些值得自动化。


## 安全边界

- 默认只读分析：不要修改、删除、移动、格式化、提交、推送、发布或部署任何文件。
- 不要运行 destructive 命令；需要命令时先说明目的，优先使用只读命令。
- 不要泄露 secrets、token、cookie、私钥或完整敏感路径。
- 如果发现需要修复的问题，只输出建议、验证步骤和可选 patch 计划，不要直接 apply。
- 输出报告时请标注证据来源、风险等级和下一步建议。



## Loop Engineering 资产扫描范围

请优先检查这些资产是否存在、是否过期、是否冲突、是否值得沉淀成循环：

- 自动化：`.github/workflows/`、package scripts、cron/schedules、hooks、`/loop` 或 goal 类配置
- 工作树：`.claude/worktrees/agent-*`、git worktree 列表、分支/dirty 状态、陈旧 agent 工作区
- 技能：`.claude/skills/`、`.hermit/skills/`、`~/.claude/skills/` 的项目相关 skill
- 插件/连接器：`.cursor/mcp.json`、`.claude/settings*.json`、MCP/plugin 配置、`src/main/services/extensions/**`
- 子 Agent：`.claude/agents/`、team manifests、agent teams、subagent tracking
- 状态：`.omc/state/`、`.omc/sessions/`、reports、tasks、last-tool-error、mission/setup state
- 指令层：`CLAUDE.md`、`AGENTS.md`、`.claude/commands/`、`workflows/`


## 分析目标

- 活跃 session、团队、子 Agent、worktree 数量和陈旧程度
- 高频/重型会话、重复任务、重复失败
- 哪些工作已经具备 loop 化条件：输入、工具、验证、状态
- token/上下文使用线索（如可用）

## 输出

1. Throughput overview
2. Expensive/repeated sessions
3. Subagent fan-out and review bottlenecks
4. Stalled worktrees or stale states
5. Automation candidates
6. Suggested consolidation into commands/skills/state

如适合写入报告，请建议 `reports/loop/loop-usage-<date>.md`，但不要自行写入，除非用户明确要求。


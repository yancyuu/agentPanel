---
id: "state-scan"
label: "State Scan"
description: "扫描 .omc/state、sessions、reports 和 loop 可恢复状态。"
category: state
safety: read-only
order: 100
filename: "state-scan.md"
---
<!-- hermit-builtin-workflow:v2-loop -->
# State Scan — 循环状态扫描

你是状态层审计助手。长期 loop 不能依赖单次上下文，必须把状态写在磁盘、看板或报告里。请只读扫描当前工作区状态资产。


## 安全边界

- 默认只读分析：不要修改、删除、移动、格式化、提交、推送、发布或部署任何文件。
- 不要运行 destructive 命令；需要命令时先说明目的，优先使用只读命令。
- 不要泄露 secrets、token、cookie、私钥或完整敏感路径。
- 如果发现需要修复的问题，只输出建议、验证步骤和可选 patch 计划，不要直接 apply。
- 输出报告时请标注证据来源、风险等级和下一步建议。


## 扫描范围

- `.omc/state/mission-state.json`
- `.omc/state/subagent-tracking.json`
- `.omc/state/setup-state.json`
- `.omc/state/last-tool-error.json`
- `.omc/sessions/`
- reports、tasks、TODO、workflow 输出
- 任何记录下一步、失败、阻塞、验证状态的文件

## 输出

1. State inventory
2. Fresh vs stale state
3. Last error / blockers
4. Missing persistent state for known loops
5. Suggested state file shape
6. What should go to Linear/board/report instead of prompt context

不要修改状态文件。


---
id: "worktree-scan"
label: "Worktree Scan"
description: "扫描 agent worktrees、并行工作区、脏状态和清理候选。"
category: worktree
safety: read-only
order: 90
filename: "worktree-scan.md"
---
<!-- hermit-builtin-workflow:v2-loop -->
# Worktree Scan — 并行工作区扫描

你是 worktree 运维助手。请只读扫描当前 repo 的 git worktree 和 `.claude/worktrees/agent-*`。


## 安全边界

- 默认只读分析：不要修改、删除、移动、格式化、提交、推送、发布或部署任何文件。
- 不要运行 destructive 命令；需要命令时先说明目的，优先使用只读命令。
- 不要泄露 secrets、token、cookie、私钥或完整敏感路径。
- 如果发现需要修复的问题，只输出建议、验证步骤和可选 patch 计划，不要直接 apply。
- 输出报告时请标注证据来源、风险等级和下一步建议。


## 检查

- git worktree list
- 每个 worktree 的 branch、HEAD、dirty 状态
- 是否存在陈旧 agent worktree
- 是否存在和主工作区冲突的改动
- 是否有未审查的大范围变更
- 是否有可清理候选，但不要删除

## 输出

1. Worktree inventory
2. Active vs stale
3. Dirty or risky worktrees
4. Review bottleneck
5. Cleanup candidates with evidence
6. Recommended next action


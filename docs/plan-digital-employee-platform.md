# 数字员工平台 — 实施计划

## 目标

让非技术业务用户通过飞书对话即可使用和管理 AI 数字员工，系统自动从团队交互中提取重复模式，沉淀为可复用的 Workflow 模板。

---

## 整体架构

```
业务用户 ←→ 飞书 ←→ cc-connect ←→ Claude Code（执行）
                          ↑
                       Hermit（调度 + 管理）
```

| 层 | 职责 | 技术 |
|---|------|------|
| 业务入口 | 用户交互界面 | 飞书群 + cc-connect Bridge |
| 调度中心 | 团队管理、Workflow 编排、参数传递 | Hermit |
| 执行引擎 | Agent 执行、Workflow 运行 | Claude Code |

---

## 1. 团队管理

一个 Team = 一个 cc-connect project，Hermit 通过 cc-connect API 管理生命周期。

### 目录结构

```
~/.hermit/teams/
├── team-frontend/
│   ├── team.json                # 团队元数据
│   ├── messages/group.jsonl     # 消息记录
│   ├── tasks/board.json         # 任务看板
│   └── pending-workflows/       # 待确认的 workflow 建议
│       └── 竞品观察.json
├── team-backend/
└── team-infra/
```

### 团队隔离

- **文件隔离**：cc-connect 每个 project 设好各自的 `work_dir`，不同目录天然隔离
- **约束规则**：CLAUDE.md 中加入目录约束指令，限制 agent 只操作当前项目目录
- **后续升级**：Wrapper 脚本支持 Docker 模式（只 mount 团队对应目录），升级时只改 wrapper 内容，Hermit 和 cc-connect 不用动

```bash
#!/bin/bash
# ~/.hermit/wrappers/team-a.sh
WORKDIR="/path/to/team-a"
exec docker run --rm -i \
  -v "$WORKDIR:/workspace" \
  -w /workspace \
  claude-image \
  claude "$@"
```

---

## 2. 自动 Workflow 沉淀

从团队交互中自动识别重复模式，生成 Workflow。

### 流程

```
Cron 每天 22:00
  → Workflow 1: 团队模式扫描器
      阶段1: 并行读取所有团队消息历史
      阶段2: 分析每个团队的重复任务模式（频率、步骤链）
      阶段3: 生成建议写入 pending-workflows/
  → Hermit 读取建议文件
  → Agent Session: 发飞书卡片给业务确认
      按钮：[确认创建] [修改] [忽略]
  → 用户点确认
  → Workflow 2: 生成目标 workflow 脚本
      读取 confirmed JSON → 生成 .claude/workflows/<name>.js → 配置 Cron
```

### Workflow 间参数传递

通过 JSON 文件，Hermit 作为调度粘合剂：

```json
{
  "teamSlug": "team-frontend",
  "patternName": "竞品观察",
  "frequency": "daily",
  "cronExpr": "0 9 * * *",
  "steps": [
    { "agent": "search", "prompt": "搜索小红书竞品动态" },
    { "agent": "analyze", "prompt": "整理分析搜索结果" },
    { "agent": "report", "prompt": "生成报告并发飞书" }
  ],
  "status": "pending"
}
```

状态流转：`pending` → `confirmed` / `ignored`

---

## 3. 业务交互层

### 飞书入口

| 用户类型 | 入口 | 场景 |
|---------|------|------|
| 业务用户 | 飞书群 @数字员工 | 发任务、看结果、确认 workflow |
| 管理员 | Hermit 管理界面 | 创建团队、监控状态、Review |
| 开发者 | Claude Code CLI | 直接操作、调试 |

### 交互示例

**任务执行：**
```
用户：@竞品观察员 今天的竞品动态
竞品观察员：报告已生成
  1. 品牌A 发布了新品...
  2. 品牌B 更新了定价...
  [查看完整报告]
```

**Workflow 建议推送：**
```
🤖 团队模式扫描器

发现你们每天都在做「竞品分析」：
  步骤：搜小红书 → 整理 → 发群
  频率：每天 ~9:00

[确认创建]  [修改] [忽略]
```

---

## 4. Skill 辅助创建

与自动扫描并行，支持业务主动描述需求创建 workflow：

- 业务在飞书中描述需求
- Skill 引导对话，收集流程信息
- 自动生成 workflow 脚本

**两种创建方式并存：**
- 自动扫描：被动发现已有行为的模式
- Skill 引导：主动创建新需求

---

## 5. 执行模式选择

| 场景 | 模式 | 原因 |
|------|------|------|
| 简单一次性任务 | Sub-agent | 快速，不需要编排 |
| 需要角色分工 | Agent Team | 多角色协作 |
| 固定流程、可重复 | Workflow | 编排可复用，不占上下文 |
| 定时任务 | Workflow + Cron | 自动触发 |
| 需要判断决策 | Skill | Claude 灵活处理 |

---

## 关键依赖

| 依赖 | 状态 | 说明 |
|------|------|------|
| cc-connect | 已有 | 团队管理 API、飞书 Bridge、Cron |
| Claude Code Workflow | 已有 | JS 脚本编排 + Cron |
| Hermit v2 架构 | 已有 | teams-mvp + ccConnect 集成 |
| 飞书卡片交互 | cc-connect 已支持 | Buttons 消息类型 |

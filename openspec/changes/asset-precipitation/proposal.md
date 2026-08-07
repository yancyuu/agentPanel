# Proposal: 用户产物沉淀（OpenSpec CLI 内置）

## Why

用户在工作台与数字员工协作时，好的工作方式（工作流、技能、行为规则）散落在聊天记录里，无法沉淀和复用。本变更把 **OpenSpec CLI 内置到产品中**，让每个数字员工的工作区成为一个 OpenSpec 项目：用户通过 agent 使用真实的 `openspec` 命令迭代、创建、归档自己的产物，产物以 OpenSpec 规范格式落盘为 living specs，下次工作直接加载复用，并可经 Git 仓库同步在团队内分发。

## What Changes

- **CLI 内置**：`@fission-ai/openspec` 作为 vendor 依赖打进 standalone 包（复用 cc-connect 的 vendor 模式），运行时经内置 node 调用，用户零安装。
- **工作区即 OpenSpec 项目**：创建团队/员工时在其 workDir 初始化 `openspec/` 项目骨架（specs/changes/archive + config），并在 **AGENTS.md** 注入产物沉淀指令（何时沉淀、用什么命令、产物类型约定）——AGENTS.md 是跨运行时标准；CLAUDE.md 仅保留指向 AGENTS.md 的指针（若运行时要求）。
- **沉淀闭环**：用户对 agent 说「沉淀一下」（或 agent 主动建议）→ agent 在自己 workDir 执行 `openspec new change` → 产出 proposal/spec/tasks → `openspec validate` → `openspec archive` 合并进 living specs。校验、冲突检测、合并全部使用 CLI 原生语义，服务端不重写。
- **产物类型**：工作流（workflow）、技能（skill）、定时任务（cron）、MCP、命令（command，对齐能力包既有五类）与行为契约（behavior contract，即调教结论），统一走 OpenSpec 沉淀；skill 等本体遵循各自既有约定（如 SKILL.md），openspec change 记录其创建/演化过程与适用场景。
- **沉淀引导追问**：沉淀工作流时，agent SHALL 按原语模型主动追问补全定义——触发（何时开始）/ 数据源（从哪取）/ 处理步骤（怎么算）/ 输出（结果给谁）/ 失败兜底（出错怎么办）/ 人工节点（要不要人确认），而非直接存档对话记录。原语模型：Trigger（定时/事件/手动）、Skill（处理逻辑；Source 是只读特化、Action 是纯写特化）、Flow（步骤图，节点类型含 skill/action/wait/checkpoint）、Memory（跨执行数据）。
- **复用**：agent 开工前读取 workDir 的 `openspec/specs/`（AGENTS.md 指令约束）；产物目录可整体走 Git 仓库同步分发给团队（与 Skills/模板的产品方向一致）。
- **归档后沉淀建议**：交付被「满意并归档」时（做法被认可的信号），系统在该任务的评审线程中追加一条沉淀建议消息，引导用户确认后进入沉淀流程；同一任务只建议一次，不重复打扰。
- **可见性**：工作台展示员工的产物库（living specs 列表与最近沉淀记录）。

## Capabilities

### New Capabilities

- `asset-precipitation`：用户经 agent 使用内置 OpenSpec CLI 在工作区沉淀、迭代、归档产物（工作流/技能/行为契约），产物可复用、可同步分发。

### Modified Capabilities

- 无。

## Impact

- **打包**：vendor 目录与 standalone 组装脚本新增 openspec；包体积随 npm 依赖增加（纯 JS，无原生模块）。
- **后端**：团队 provisioning 增加 openspec 项目初始化与 AGENTS.md 托管块；产物库读取路由。
- **agent 侧**：通过既有 direct-CLI 会话执行 openspec 命令（bash 能力已具备），无需新工具。
- **数据**：员工 workDir 新增 `openspec/` 目录；无存量迁移。
- **明确不做**：行为回放 eval、产物的手工编辑 UI（v1 只读展示）、跨团队产物市场。

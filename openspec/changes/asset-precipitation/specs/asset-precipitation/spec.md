## Purpose

用户在工作台中通过数字员工使用内置的 OpenSpec CLI，将工作流、技能、行为规则等产物以 OpenSpec 规范沉淀到员工工作区，形成可复用、可追溯、可分发的 living specs 产物库。

## ADDED Requirements

### Requirement: OpenSpec CLI 随产品内置

产品安装包 MUST 内置版本锁定的 OpenSpec CLI，agent SHALL 能通过产品内置的运行时直接执行 `openspec` 命令（new change / validate / archive / status），不要求用户机器预装 Node.js 或 npm。

#### Scenario: 零安装执行

- **WHEN** 用户机器未安装 Node.js，agent 在工作区执行 `openspec --version`
- **THEN** 命令经产品内置运行时正常执行并返回版本号

### Requirement: 工作区即 OpenSpec 项目

创建团队/员工时，系统 SHALL 在其 workDir 初始化标准 OpenSpec 项目骨架（`openspec/specs`、`openspec/changes`、`openspec/archive`、config），并注入产物沉淀指令（托管块形式，幂等）。对存量团队，首次触发沉淀时 MUST 幂等补初始化。初始化 MUST NOT 覆盖工作区已有的 openspec 内容。

#### Scenario: 新团队自动初始化

- **WHEN** 创建一个新团队并完成 provisioning
- **THEN** 其 workDir 存在标准 openspec 项目骨架，AGENTS.md 含产物沉淀托管块

#### Scenario: 存量团队幂等补建

- **WHEN** 一个无 openspec 目录的存量团队首次触发沉淀
- **THEN** 系统自动补齐项目骨架；若目录已存在则原样保留

### Requirement: 沉淀闭环使用 CLI 原生语义

产物沉淀 MUST 经由 openspec CLI 完成：创建 change、编写工件、`validate` 校验、`archive` 归档合并进 living specs。系统 MUST NOT 以自实现逻辑替代 CLI 的校验、冲突检测与合并语义；archive 失败（如 MODIFIED/REMOVED 匹配冲突）SHALL 将 CLI 原始错误呈现给 agent 修正重试。

#### Scenario: 一次完整沉淀

- **WHEN** 用户要求 agent 沉淀一个工作流，agent 依次执行 new change、写工件、validate、archive
- **THEN** `openspec/specs/` 中出现该工作流的 living spec，change 进入 archive

#### Scenario: 归档冲突原样反馈

- **WHEN** agent 执行 archive 时 delta 的 MODIFIED 无法匹配既有 Requirement
- **THEN** archive 失败，CLI 原始错误信息对 agent 可见，living specs 保持不变

### Requirement: 产物开工复用

agent 接受任务时 SHALL 先检查工作区 `openspec/specs/` 是否存在相关产物，存在时 MUST 按其内容执行或参考。沉淀指令托管块 MUST 明确该约束。

#### Scenario: 命中产物直接复用

- **WHEN** 工作区 specs 中已有「周报生成」工作流，用户再次要求生成周报
- **THEN** agent 按该工作流的步骤执行，而非重新摸索流程

### Requirement: 工作流沉淀引导追问

沉淀工作流类产物时，agent SHALL 按原语模型（Trigger / Skill / Flow / Memory）主动向用户追问补全定义，至少覆盖：触发条件、数据来源、处理步骤、输出去向、失败兜底、是否需要人工确认节点；追问结果 MUST 整理为结构化 spec 而非直接存档对话记录。Checkpoint（人工确认）与 wait（等待/计时）MUST 建模为 Flow 的节点类型，不得建模为 Trigger。

#### Scenario: 追问补齐后沉淀

- **WHEN** 用户要求把「每天 9 点生成数据快报」沉淀为工作流，但未说明失败处理方式
- **THEN** agent 先追问失败兜底等问题，再将完整定义沉淀为 Flow spec

#### Scenario: 计时条件建模为等待节点

- **WHEN** 工作流包含「24 小时未处理则升级」之类的时间条件
- **THEN** spec 中该条件表达为 Flow 的 wait 节点（状态存 Memory），而非 Trigger

### Requirement: 归档后沉淀建议

交付被「满意并归档」后，系统 SHALL 在该任务的评审线程追加一条沉淀建议消息（source='precipitation_suggestion'），引导用户回复确认后进入沉淀流程。同一任务 MUST 只建议一次：写入前发现线程已存在该任务的建议消息则跳过。系统 MUST NOT 未经用户确认自动沉淀产物。

#### Scenario: 归档后提出建议

- **WHEN** 任务 T 的交付被满意并归档，且 T 的线程中尚无沉淀建议消息
- **THEN** 线程追加一条 source 为 precipitation_suggestion 的建议消息，提示用户回复确认即可沉淀

#### Scenario: 同一任务不重复建议

- **WHEN** 任务 T 的线程中已存在沉淀建议消息，T 再次发生归档
- **THEN** 不再追加建议消息

### Requirement: 产物库可见性

工作台 SHALL 展示每个员工的产物库：living specs 列表（标题、最近更新时间）与最近沉淀记录（change 标识、时间、涉及操作类型），均为只读。

#### Scenario: 查看产物库

- **WHEN** 用户打开某员工的产物库视图
- **THEN** 可见该员工全部 living specs 与最近沉淀记录；无产物时展示空态说明

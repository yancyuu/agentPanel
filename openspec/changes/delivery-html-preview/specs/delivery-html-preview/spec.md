## Purpose

交付成果按内容类型渲染：HTML 成果呈现为真实页面视图，用户验收所见即所得，而非阅读文字描述。

## ADDED Requirements

### Requirement: HTML 成果视图渲染

交付内容被嗅探为完整 HTML 文档时，成果区 SHALL 以沙盒 iframe 渲染为页面视图，并提供「预览/源码」切换（默认预览）；非 HTML 内容 MUST 维持既有 markdown 渲染不变。

#### Scenario: HTML 成果默认渲染为视图

- **WHEN** 一版交付的内容是完整 HTML 文档
- **THEN** 成果区默认显示渲染后的页面视图，可切换到源码查看原始 HTML

#### Scenario: markdown 成果不受影响

- **WHEN** 交付内容为 markdown 文本
- **THEN** 维持 markdown 渲染，不出现预览/源码切换

### Requirement: 渲染安全约束

HTML 成果的 iframe MUST 启用 sandbox 且不允许脚本执行（无 allow-scripts）；成果中的脚本、表单提交与顶层导航 MUST NOT 影响工作台上下文。

#### Scenario: 成果内脚本不执行

- **WHEN** HTML 成果包含 script 标签或内联事件处理
- **THEN** 视图渲染时脚本不执行，工作台无对应副作用

### Requirement: 页面类交付指引

agent 的交付指引（AGENTS.md 沉淀指令与任务派发提示）SHALL 明确：页面/设计类任务的交付物应为自包含 HTML（内联样式、不依赖外部脚本）。

#### Scenario: 指引包含 HTML 交付要求

- **WHEN** 检查工作区 AGENTS.md 的沉淀指令托管块
- **THEN** 包含页面类成果应交付自包含 HTML 的说明

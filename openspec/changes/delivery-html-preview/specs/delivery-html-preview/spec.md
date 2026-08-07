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

### Requirement: 渲染安全约束与交互性

HTML 成果的 iframe MUST 启用 sandbox。为支持成果内组件交互，SHALL 允许 `allow-scripts`（成果内脚本可运行，按钮/链接/组件可交互），但 MUST NOT 允许 `allow-same-origin`（保持 opaque origin，成果脚本无法读取工作台存储、会话与 cookie），且 MUST NOT 允许顶层导航（成果不得将工作台页面导航走）；新窗口打开经 `allow-popups` + `allow-popups-to-escape-sandbox` 交给浏览器处理。

#### Scenario: 成果内组件可交互

- **WHEN** HTML 成果包含按钮、链接或 JS 驱动的组件
- **THEN** 视图内组件可点击可交互，脚本在沙盒中运行

#### Scenario: 成果脚本无法触达工作台

- **WHEN** HTML 成果的脚本尝试访问工作台 origin 的存储/cookie 或执行顶层导航
- **THEN** 因 opaque origin 与导航限制被拒绝，工作台无副作用

### Requirement: 页面类交付指引

agent 的交付指引（AGENTS.md 沉淀指令与任务派发提示）SHALL 明确：页面/设计类任务的交付物应为自包含 HTML（内联样式、不依赖外部脚本）。

#### Scenario: 指引包含 HTML 交付要求

- **WHEN** 检查工作区 AGENTS.md 的沉淀指令托管块
- **THEN** 包含页面类成果应交付自包含 HTML 的说明

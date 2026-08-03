# Proposal: 交付成果按类型渲染（HTML 视图预览）

## Why

交付成果目前一律按 markdown 文本渲染。页面/设计类成果（如落地页改版）用户需要看到真实视图而非文字描述——「交付的是页面，就该看到页面」。

## What Changes

- **HTML 成果视图渲染**：交付内容嗅探为 HTML（`<html`/`<!DOCTYPE` 或以标签为主体的完整文档）时，用沙盒 iframe 渲染为真实视图，提供「预览/源码」切换；非 HTML 内容维持 markdown 渲染。
- **安全约束**：iframe `sandbox`（无脚本执行；样式与布局可渲染），禁止成果内脚本在工作台上下文运行。
- **交付指引**：AGENTS.md 沉淀指令/任务派发提示补充——页面/设计类任务的交付物应是自包含 HTML（内联样式、无外部脚本依赖），而非文字描述。

## Capabilities

### New Capabilities

- `delivery-html-preview`：HTML 类型交付成果的视图渲染与安全约束。

## Impact

- `TaskDeliveriesSection`/`TaskReviewThread` 的成果渲染处（新增 DeliveryContentView：类型嗅探 + iframe 预览 + 源码切换）；AGENTS.md 托管块（asset-precipitation 指令）与派发提示文案。
- 不改 deliveries 数据模型（无新增字段，按内容嗅探）。

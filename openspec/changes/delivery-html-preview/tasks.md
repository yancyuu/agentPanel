# Tasks: 交付成果 HTML 视图预览

## 1. 渲染

- [x] 1.1 DeliveryContentView：HTML 嗅探（`<!DOCTYPE`/`<html` 或标签主体完整文档）→ sandbox iframe（无 allow-scripts）预览 + 「预览/源码」切换；非 HTML 走 MarkdownViewer
- [x] 1.2 接入 TaskDeliveriesSection 与 TaskReviewThread 的交付卡片（同一组件）

## 2. 指引

- [x] 2.1 AGENTS.md 沉淀指令托管块补「页面/设计类成果交付自包含 HTML（内联样式、无外部脚本依赖）」；派发提示同步

## 3. 测试

- [x] 3.1 嗅探双向（HTML→iframe 预览默认+可切源码；markdown→原渲染）、sandbox 无 allow-scripts、指引文案断言
- [x] 3.2 全量 vitest + typecheck

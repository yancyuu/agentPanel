# Tasks: 用户产物沉淀（OpenSpec CLI 内置）

## 1. CLI 内置

- [x] 1.1 vendor `@fission-ai/openspec`（版本锁定）进 standalone 包，复用 cc-connect 的 vendor/组装模式
- [x] 1.2 运行时调用封装：`<内置 node> <vendor>/openspec/... <args>`，对 agent 会话暴露一致的命令入口（PATH 或包装脚本）
- [x] 1.3 打包验证：standalone 包在无系统 Node 的环境可执行 `openspec --version`

## 2. 工作区初始化与注入

- [x] 2.1 provisioning 增加 openspec 项目初始化（幂等，不覆盖已有内容）
- [x] 2.2 AGENTS.md 托管块 `hermit:asset-precipitation`：沉淀触发时机、命令序列、产物类型约定（workflow/skill/cron/mcp/command/behavior-contract）、开工先读 specs 约束、常见 CLI 错误处理示例；CLAUDE.md 仅保留指向 AGENTS.md 的指针
- [x] 2.3 存量团队补初始化路径（首次沉淀触发时）

## 3. 产物库读取与展示

- [x] 3.1 读取路由：解析 workDir `openspec/specs/`（标题/更新时间）与 `openspec/changes/archive/`（change 标识/时间/操作统计）
- [x] 3.2 工作台产物库视图：living specs 列表 + 最近沉淀记录 + 空态

## 3A. 归档后沉淀建议（D7）

- [x] 3A.1 set_column(approved) 写归档收尾消息后，追加 source='precipitation_suggestion' 的建议消息（引导文案：回复「沉淀一下」即进入沉淀）；写入前检查该任务线程已有建议消息则跳过
- [x] 3A.2 InboxMessage.source 类型与消息映射同步支持 'precipitation_suggestion'；线程 UI 正常渲染该消息（样式可为轻量提示卡）
- [x] 3A.3 用例：首次归档出建议、二次归档不重复、建议消息在 messages 读取中正确返回

## 4. 测试与验证

- [x] 4.1 初始化幂等用例、托管块注入/移除用例
- [x] 4.2 产物库读取路由用例（specs/archive 解析、空态）
- [x] 4.3 前端产物库视图用例
- [x] 4.4 `pnpm vitest run` 相关套件 + `pnpm typecheck` 全绿
- [ ] 4.5 端到端人工验收：在演示团队让 agent 沉淀一个真实工作流，验证「沉淀 → specs 可见 → 新会话复用」全链路（对应 specs 全部 Scenario）

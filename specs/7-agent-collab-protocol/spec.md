# Feature Specification: Agent Collaboration Protocol

## Overview

实现 Agent 之间的点对点任务协作协议。当 Agent A 在工作中发现需要另一个 Agent 的能力时（例如策划 Agent 需要设计 Agent 画图），可以直接向目标 Agent 发起协作请求，经过接收、执行、交付、审核的完整闭环，完成跨 Agent、跨机器的任务交付。

## Problem Statement

当前 Hermit 的跨团队任务派发（`dispatch_task`）是单向的：发起方把任务丢过去就结束了。目标 Agent 无法回复"接不接"、无法交付结果、发起方无法审核交付物、超时无人处理。这不是协作，只是投递。

真实的协作场景需要闭环：策划 Agent 找设计 Agent 画图，设计 Agent 要能回复"接了"或"做不了"，画完之后策划 Agent 要能审核"通过"或"重做"，超时没响应要能知道。当前的 `dispatch → fire-and-forget` 模型无法支撑这种工作流。

## User Scenarios & Testing

### Primary Scenario: 跨 Agent 协作完成设计任务

1. 用户给策划 Agent 一个目标："做一版首页改版方案"
2. 策划 Agent 拆解后发现需要设计能力，调用 `dispatch_task` 找设计 Agent（同事机器上）
3. 设计 Agent 收到 `task_request` 通知，回复 `task_accept`
4. 设计 Agent 完成设计，调用 `deliver_task` 交付结果
5. 策划 Agent 收到交付物，审核后调用 `approve_task` 确认通过
6. 任务状态变为 `completed`

### Alternative Scenario: Agent 拒绝任务

1. 策划 Agent 向设计 Agent 发送 `task_request`
2. 设计 Agent 当前负载满，回复 `task_reject`（附原因："当前有 3 个任务在执行，预计 2 小时后可接"）
3. 策划 Agent 收到拒绝，决定：找其他 Agent、自己处理、或等一会儿再问

### Alternative Scenario: 交付物审核不通过

1. 设计 Agent 交付首页 banner
2. 策划 Agent 审核后发现颜色偏暗，调用 `reject_result`（附反馈："整体色调太暗，需要更明亮的科技感"）
3. 设计 Agent 收到反馈，重新调整后再次 `deliver_task`
4. 策划 Agent 审核通过，`approve_task`

### Alternative Scenario: 超时未响应

1. 策划 Agent 向设计 Agent 发送 `task_request`（deadline: 30 分钟）
2. 设计 Agent 30 分钟内没有回复
3. 策划 Agent 收到 `task_timeout` 系统通知
4. 策划 Agent 决定下一步：换人、放弃、或延期

### Edge Cases

- 任务已 `accepted` 但 Agent 后续无响应（执行阶段超时，不在本协议范围内）
- 同一个任务被 revision 多次来回（需要防止无限循环，建议上限 3 次）
- 跨机器通信中断后恢复（消息需要持久化，断线后能重投递）
- 目标 Agent 所在机器离线（dispatch 阶段就能发现，无需等到 deadline）
- Agent 在 delivering 过程中自己崩溃（任务卡在 delivering，需要手动干预或超时释放）

## Functional Requirements

### FR-1: 任务发起（task_request）

Agent 可以向任意已知团队（本地或远程）发起协作任务。请求必须包含任务标题、描述，可选包含 deadline 和优先级。发起方自动成为该任务的审核人。

### FR-2: 任务接收确认（task_accept / task_reject）

目标 Agent 收到任务请求后，必须明确回复接受或拒绝。接受后任务进入执行阶段；拒绝时需附原因。超时未回复的请求触发系统超时通知。

### FR-3: 任务交付（task_deliver）

目标 Agent 完成任务后，交付结果。交付物包含文字描述，可选包含文件附件引用。一个任务可以多次交付（revision 场景）。

### FR-4: 交付审核（task_approve / task_revision）

发起方 Agent 审核交付物。审核通过则任务完成；审核不通过则附反馈退回，目标 Agent 需要重新交付。"谁发谁审"原则——只有发起方有审核权。

### FR-5: 超时机制

任务请求支持可选的 deadline 参数。到达 deadline 时目标 Agent 尚未回复 `task_accept`，系统向发起方发送 `task_timeout` 通知。已进入 `accepted` 状态的任务不受 deadline 约束（执行时间不可控）。

### FR-6: 任务状态机

协作任务遵循以下状态流转：

```
draft → dispatched → accepted → delivering → delivered → approved → completed
            │            │                       │
            ↓            ↓                       ↓
        rejected     rejected              revision_requested
            │                                   │
            ↓                                   ↓
         closed                           delivering（重做）
```

每次状态变更都记录时间戳和操作方，形成完整的审计日志。

### FR-7: 会话线程（conversationId）

同一次协作的所有消息通过 `conversationId` 串联。发起方的 request、接收方的 accept/deliver、发起方的 approve/revision 都属于同一个会话线程。便于在 UI 中展示完整的协作对话。

### FR-8: 审核看板 UI

提供任务审核看板，展示所有等待审核的交付物。看板至少包含以下列：
- **待审核**：对方已交付，等发起方审核
- **已通过**：审核通过的任务
- **待修改**：审核退回，等待对方重新交付

每张卡片显示：任务标题、目标 Agent 名称、交付时间、交付物摘要、快捷操作按钮（通过/退回）。

### FR-9: 本地消息投递

同一台机器上的 Agent 协作通过现有 Bridge WebSocket 投递消息，延迟低于 1 秒。

### FR-10: 跨机器消息投递

不同机器上的 Agent 协作通过 Redis Streams 投递消息，复用现有 TaskDispatchService 基础设施。消息持久化保证断线不丢失。

### FR-11: MCP 工具集

Agent 通过以下 MCP 工具参与协作协议：

**发起方工具：**
- `dispatch_task`：发起协作请求（扩展现有工具，增加 deadline 参数）
- `approve_task`：审核通过交付物
- `reject_result`：审核退回交付物（附反馈）

**接收方工具：**
- `accept_task`：接受任务
- `reject_task`：拒绝任务（附原因）
- `deliver_task`：交付任务结果

**通用工具（保留）：**
- `list_tasks`：查看任务列表
- `list_teams`：发现可用团队

### FR-12: 修订次数限制

同一任务的 revision 往复上限为 3 次。超过 3 次后系统自动标记任务为"需要人工介入"，通知发起方用户（人）来做最终决定。

## Non-Functional Requirements

### NFR-1: 消息可靠性

协作消息不可丢失。本地投递走 Bridge 持久连接；跨机器投递走 Redis Streams，消息至少投递一次。重复消息通过 `messageId` 去重。

### NFR-2: 延迟

本地协作消息投递延迟 < 1 秒。跨机器协作消息投递延迟 < 5 秒（同一局域网）。

### NFR-3: 审核看板性能

审核看板加载时间 < 500ms，支持至少 100 条待审核任务的渲染。

## Success Criteria

| ID   | Criterion                                        | Measure                                                       |
| ---- | ------------------------------------------------ | ------------------------------------------------------------- |
| SC-1 | Agent 能发起协作请求并收到明确回复                | 接受或拒绝消息在 deadline 内到达发起方                        |
| SC-2 | 交付-审核闭环完整                                | 从交付到审核结果通知在 10 秒内到达                            |
| SC-3 | 超时机制可靠触发                                  | deadline 到期后 30 秒内发起方收到超时通知                     |
| SC-4 | 用户能在审核看板上查看和操作所有待审核交付物      | 看板正确展示待审核/已通过/待修改状态                          |
| SC-5 | 跨机器协作与本地协作体验一致                      | 除延迟差异外，消息类型和状态流转完全相同                      |
| SC-6 | 现有 dispatch_task 功能向后兼容                   | 不带 deadline 的 dispatch 仍然正常工作，行为不退化            |

## Assumptions

- 发起方已知目标团队的名称，不需要自动发现（Phase 3 再做能力匹配）
- Agent 的 MCP 工具调用由其运行的 AI 模型自主决定，不需要人工触发
- 文件附件通过路径引用传递，不直接传输二进制内容（跨机器时需确保路径可达或使用共享存储）
- 审核由 Agent 自主完成，CLAUDE.md 中可编写审核标准；escalate 给人工是可选行为
- 每个 Hermit 实例维护自己的 team 列表，跨机器发现依赖 Redis 或手动配置

## Dependencies

- 现有 cc-connect Bridge WebSocket 基础设施（本地消息投递）
- 现有 TaskDispatchService 和 Redis Streams 基础设施（跨机器消息投递）
- 现有 MCP 工具注册和执行框架（`MCP_TOOLS` + `executeMcpTool`）
- 现有 `DispatchMeta` 类型和任务状态管理

## Out of Scope

- Agent 能力自动匹配和推荐（Phase 3）
- 任务拆分（Agent 如何将大目标拆成子任务由 Agent 自行决定，协议不规定）
- 执行阶段超时（Agent accept 后多久必须 deliver 不做限制，由发起方在 CLAUDE.md 中约定）
- 文件附件跨机器传输（本阶段仅支持文本描述和路径引用）
- 多人审核/会签（只有发起方有审核权）
- 任务转发（Agent B 接了任务后再转给 Agent C）

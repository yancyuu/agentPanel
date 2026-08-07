# Research: cc-connect Sidecar Architecture

## R1: cc-connect 动态创建 Project 机制

**Decision**: 使用 `POST /api/v1/{project-name}/add-platform` + `POST /api/v1/restart`

**Rationale**: cc-connect 没有直接的 `POST /api/v1/projects` 创建端点。项目创建通过 `add-platform` 实现 —— 当 project 不存在时自动创建完整的项目骨架（agent_type + work_dir + platform），然后需要 restart 才能启动新 engine。

**Alternatives considered**:
- 直接修改 config.toml + reload: 不够 —— reload 只更新已有 engine，不启动新 project
- 使用 setup 流程（feishu/weixin）: 仅适用于特定平台 QR 码配对，不通用

**实现细节**:
```
POST /api/v1/{name}/add-platform
Body: { "type": "bridge", "options": {}, "work_dir": "/path", "agent_type": "claudecode" }
→ 自动创建 project 如果不存在
→ Response: { "message": "platform added", "restart_required": true }

POST /api/v1/restart
→ cc-connect exec-replace 重启，新 project engine 启动
```

## R2: Bridge WebSocket 作为通信通道

**Decision**: Hermit 通过 Bridge WebSocket 注册为 `platform: "hermit"` adapter

**Rationale**: Bridge WS 提供完整的双向实时通信 —— 注册后可接收 agent 的所有输出（reply, stream, card, buttons, typing），也可发送用户消息。比轮询 session history 更实时。

**Session Key 格式**: `bridge:{user_id}:{chat_id}` — Hermit 使用 `bridge:hermit-{teamName}:{memberName}`

**Capabilities**: `["text", "buttons", "card", "typing", "update_message", "preview"]`

## R3: Relay vs Bridge WS 用于跨 Agent 通信

**Decision**: 暂不使用 relay API，通过 Hermit 自身做消息路由

**Rationale**:
- Relay API 在 Unix socket 上（`/relay/send`），不在 Management HTTP API 上
- Relay 设计用于 "群聊中多 bot 对话"，与 Hermit 的任务编排模型不完全匹配
- Hermit 可以通过 Bridge WS 分别和每个 member project 通信，在应用层做路由

**Alternatives considered**:
- 使用 relay: 需要额外暴露 Unix socket 或新增 HTTP 端点
- 改造 cc-connect 添加 HTTP relay: 侵入 cc-connect 代码

## R4: cc-connect 可用性检测

**Decision**: 使用 `GET /api/v1/status` 做定期 health check

**Rationale**: status 端点轻量，返回版本、运行时间、项目数等基础信息，适合作为 liveness probe。

**轮询间隔**: 10 秒（正常时）/ 3 秒（断开后重试）

## R5: Platform type 选择

**Decision**: 使用 `"bridge"` 作为 Hermit 创建 project 时的 platform type

**Rationale**: Hermit 不是传统聊天平台（飞书/Telegram），而是通过 Bridge WebSocket 协议与 cc-connect 通信。使用 `bridge` type 最合理，它正是为外部 adapter 设计的。

**注意**: Bridge platform 需要 cc-connect 的 Bridge Server 启动（默认端口 9810），需确保 cc-connect 配置了 `[bridge]` 段。

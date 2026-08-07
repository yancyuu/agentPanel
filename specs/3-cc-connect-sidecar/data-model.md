# Data Model: cc-connect Sidecar Architecture

## Entity: CcConnectProjectMapping

持久化 Hermit team member 与 cc-connect project 的映射关系。

```
CcConnectProjectMapping {
  teamName: string          // Hermit 团队名
  memberName: string        // 成员名（如 "lead", "worker-1"）
  ccProjectName: string     // cc-connect 中的 project name（如 "hermit-myteam-lead"）
  agentType: AgentType      // "claudecode" | "codex" | "gemini" | "opencode" | "qoder" | ...
  workDir: string           // Agent 工作目录
  sessionKey: string?       // Bridge session key（如 "bridge:hermit-myteam:lead"）
  createdAt: ISO8601        // 创建时间
  updatedAt: ISO8601        // 最后更新时间
}
```

**命名规则**: `ccProjectName` = `hermit-{teamName}-{memberName}`（slug 化）

**存储**: `~/.hermit/cc-connect-mappings.json`

**关系**:
- Team 1:N CcConnectProjectMapping
- CcConnectProjectMapping 1:1 cc-connect Project

## Entity: CcConnectConfig

cc-connect 连接配置。

```
CcConnectConfig {
  baseUrl: string           // Management API 地址，默认 "http://127.0.0.1:9820"
  bridgeUrl: string         // Bridge WebSocket 地址，默认 "ws://127.0.0.1:9810/bridge/ws"
  token: string             // 认证 token
  bridgeToken: string?      // Bridge 专用 token（可选，默认同 token）
}
```

**存储**: Hermit settings.json + env vars (`CC_CONNECT_BASE_URL`, `CC_CONNECT_TOKEN`)

## Entity: CcConnectStatus

cc-connect 运行状态（运行时，不持久化）。

```
CcConnectStatus {
  connected: boolean
  version: string?
  uptime: number?           // 秒
  projectCount: number
  lastCheckedAt: ISO8601
  error: string?
}
```

## State Transitions

### Team Launch via cc-connect

```
[Draft] → launchTeam()
  → createProject() for each member
  → cc-connect restart
  → Bridge WS 确认连接
  → sendInitialPrompt()
→ [Running]

[Running] → stopTeam()
  → deleteProject() for each member
  → cc-connect restart
→ [Stopped]
```

### cc-connect 连接状态

```
[Disconnected] → GET /api/v1/status 成功 → [Connected]
[Connected] → GET /api/v1/status 失败 → [Disconnected]
[Connected] → Bridge WS 连接成功 → [Streaming]
[Streaming] → Bridge WS 断开 → [Connected] (仅 health check, 无实时流)
```

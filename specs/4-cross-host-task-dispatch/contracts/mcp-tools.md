# MCP Tool Contracts

## list_teams

Returns all discoverable teams (local + remote via Redis).

### Input
No parameters.

### Output
```json
{
  "teams": [
    {
      "slug": "alpha",
      "displayName": "Alpha Team",
      "location": "local",
      "status": "online",
      "collaboration": true
    },
    {
      "slug": "beta",
      "displayName": "Beta Team",
      "location": "remote",
      "status": "online",
      "collaboration": true
    }
  ]
}
```

### Behavior
- Reads local teams from `TeamWorkspaceService.listTeams()`
- If Redis configured, reads `ZRANGE task:teams 0 -1` for remote teams
- Filters stale entries (heartbeat > 90s ago)
- Only includes teams with `collaboration !== false`

---

## dispatch_task

Dispatches a task to a target team.

### Input
```json
{
  "targetTeam": "beta",
  "subject": "Fix login bug",
  "description": "Users report 401 on /api/auth",
  "prompt": "Check the auth middleware in src/middleware/auth.ts"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| targetTeam | yes | Slug of target team |
| subject | yes | Task title |
| description | no | Task description |
| prompt | no | Agent instructions |

### Output
```json
{
  "dispatchId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "dispatched",
  "targetTeam": "beta",
  "message": "Task dispatched to beta"
}
```

### Behavior
- Validates target team exists and is online
- Validates source team has `collaboration !== false`
- Creates `DispatchMeta` with `dispatchId`
- If target is local → writes directly to target `board.json`
- If target is remote → `XADD task:dispatch:{targetTeam}`
- Returns immediately with `dispatched` status

### Errors
| Condition | Error |
|-----------|-------|
| Target team not found | "Team 'xyz' not found" |
| Target team offline | "Team 'xyz' is currently offline. Task queued for delivery." |
| Source team collaboration disabled | "Cross-team dispatch is disabled for this team" |
| Target team collaboration disabled | "Team 'xyz' does not accept dispatches" |

---

## Existing: complete_task (modified)

After completing a dispatched task, notifies origin team.

### Added Behavior
- Check if task has `dispatchMeta`
- If yes → `PUBLISH task:status:{originTeam}` with `{ dispatchId, status: "completed" }`
- Update `dispatchMeta.status = "completed"`

---

# HTTP API Contracts

## GET /api/cross-team/targets

Returns list of dispatchable teams.

### Response
```json
{
  "teams": [ /* same as list_teams MCP output */ ]
}
```

## POST /api/cross-team/send

Accepts CrossTeamSendRequest (existing type), routes through TaskDispatchService.

### Request
```json
{
  "fromTeam": "alpha",
  "fromMember": "lead",
  "toTeam": "beta",
  "text": "dispatch_task subject: Fix login bug",
  "taskRefs": []
}
```

### Response
```json
{
  "ok": true,
  "dispatchId": "uuid"
}
```

## GET /api/cross-team/outbox/:name

Returns pending dispatches for a team.

### Response
```json
{
  "pending": [
    {
      "dispatchId": "uuid",
      "targetTeam": "beta",
      "subject": "Fix login bug",
      "dispatchedAt": "2026-05-25T10:00:00Z",
      "status": "dispatched"
    }
  ]
}
```

## GET /api/settings/task-bus

Returns current task bus configuration.

### Response
```json
{
  "enabled": false,
  "redis": { "host": "127.0.0.1", "port": 6379, "password": null, "db": 0 }
}
```

## PUT /api/settings/task-bus

Updates task bus configuration. Triggers Redis reconnect if changed.

### Request
```json
{
  "enabled": true,
  "redis": { "host": "10.0.0.5", "port": 6379, "password": "secret", "db": 0 }
}
```

### Response
```json
{
  "ok": true,
  "connected": true,
  "message": "Connected to Redis at 10.0.0.5:6379"
}
```

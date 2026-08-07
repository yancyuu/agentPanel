# Data Model: Cross-Host Task Dispatch

## New Types

### DispatchMeta
Tracks cross-team dispatch lifecycle on a TeamTask.

| Field | Type | Description |
|-------|------|-------------|
| dispatchId | string (UUID) | Unique transaction ID for this dispatch |
| originTeam | string | Slug of the team that created the task |
| targetTeam | string | Slug of the team receiving the task |
| status | DispatchStatus | Current dispatch state |
| dispatchedAt | string (ISO) | When the dispatch was sent |
| receivedAt | string (ISO)? | When target confirmed receipt |
| completedAt | string (ISO)? | When target completed |
| remoteTaskId | string? | Task ID created on target team's board |

### DispatchStatus
```
dispatched → received → in_progress → completed → synced_back
                 ↑                        ↓
               failed ←←←←←←←←←←←←←←←←←←┘
```

### DiscoverableTeam
Result of `list_teams` MCP tool.

| Field | Type | Description |
|-------|------|-------------|
| slug | string | Team identifier |
| displayName | string | Human-readable name |
| location | 'local' \| 'remote' | Same host or different host |
| status | 'online' \| 'offline' | Current connectivity |
| collaboration | boolean | Whether team accepts dispatches |

### TaskBusConfig
Settings for Redis message bus.

| Field | Type | Description |
|-------|------|-------------|
| enabled | boolean | Master switch |
| redis.host | string | Redis hostname |
| redis.port | number | Redis port |
| redis.password | string? | Optional auth |
| redis.db | number? | Database number (default 0) |

## Redis Schema

### Streams
| Key | Producer | Consumer | Purpose |
|-----|----------|----------|---------|
| `task:dispatch:{teamSlug}` | Origin Hermit | Target Hermit | Task dispatch payload |
| `task:ack:{dispatchId}` | Target Hermit | Origin Hermit | Delivery confirmation |

### Pub/Sub Channels
| Channel | Publisher | Subscriber | Purpose |
|---------|-----------|------------|---------|
| `task:status:{originTeam}` | Target Hermit | Origin Hermit | Status change notifications |

### Sorted Sets
| Key | Member | Score | Purpose |
|-----|--------|-------|---------|
| `task:teams` | teamSlug | timestamp | Team presence heartbeat |

## Payload Formats

### TaskDispatchPayload (Stream message)
```json
{
  "dispatchId": "uuid",
  "originTeam": "alpha",
  "targetTeam": "beta",
  "task": {
    "subject": "Fix login bug",
    "description": "...",
    "prompt": "...",
    "descriptionTaskRefs": [],
    "promptTaskRefs": []
  },
  "dispatchedAt": "2026-05-25T10:00:00Z"
}
```

### TaskStatusUpdate (Pub/Sub message)
```json
{
  "dispatchId": "uuid",
  "originTeam": "alpha",
  "status": "completed",
  "remoteTaskId": "uuid-on-beta",
  "timestamp": "2026-05-25T10:05:00Z",
  "result": "Fixed by updating auth middleware"
}
```

### TaskAckPayload (Stream message)
```json
{
  "dispatchId": "uuid",
  "status": "received",
  "remoteTaskId": "uuid-on-beta",
  "timestamp": "2026-05-25T10:00:01Z"
}
```

## TeamTask Modifications

Single new optional field on existing `TeamTask`:

```diff
  export interface TeamTask {
    // ... existing fields ...
    sourceMessage?: SourceMessageSnapshot;
+   dispatchMeta?: DispatchMeta;
  }
```

No breaking changes — `dispatchMeta` is optional and ignored by existing code.

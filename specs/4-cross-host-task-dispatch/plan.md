# Implementation Plan: Cross-Host Team Task Dispatch

## Technical Context

| Item | Value |
|------|-------|
| Feature Branch | `4-cross-host-task-dispatch` |
| Spec | `specs/4-cross-host-task-dispatch/spec.md` |
| Transport (remote) | Redis Streams + Pub/Sub |
| Transport (local) | Direct board.json write + in-process events |
| MCP Interface | Extend existing `hermit-tasks` MCP server |
| New Dependency | `ioredis` (optional — only loaded when Redis configured) |
| Files Changed | ~10 files, ~800 lines |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Hermit Instance A                                       │
│                                                         │
│  Agent ──MCP──▶ hermit-tasks server                     │
│                   │ list_teams()                        │
│                   │ dispatch_task(target, ...)          │
│                   │ complete_task(...)                  │
│                   ▼                                      │
│              TaskDispatchService                         │
│              ┌───────┬───────────┐                      │
│              │ Local │ Remote    │                      │
│              │ path  │ path      │                      │
│              │  ↓    │  ↓        │                      │
│           board.json  Redis Streams/PubSub              │
│                        │                                │
└────────────────────────┼────────────────────────────────┘
                         │
                    ┌────▼────┐
                    │  Redis  │  (optional)
                    └────┬────┘
                         │
┌────────────────────────┼────────────────────────────────┐
│ Hermit Instance B      ▼                                │
│                                                         │
│  TaskDispatchService ◀── XREADGROUP                     │
│       │                                                 │
│       ▼                                                 │
│  board.json  →  Agent picks up  →  complete_task()      │
│                                      │                  │
│                              PUBLISH status sync         │
└──────────────────────────────────────────────────────────┘
```

## Data Model

### TeamTask Extension

Add `dispatchMeta` to existing `TeamTask`:

```typescript
interface DispatchMeta {
  dispatchId: string;          // unique dispatch transaction ID
  originTeam: string;          // team that created the task
  targetTeam: string;          // team receiving the task
  status: DispatchStatus;      // dispatch lifecycle state
  dispatchedAt: string;        // ISO timestamp
  receivedAt?: string;
  completedAt?: string;
  remoteTaskId?: string;       // task ID created on the target team
}

type DispatchStatus =
  | 'dispatched'   // sent, awaiting ack
  | 'received'     // target confirmed receipt
  | 'in_progress'  // target agent working
  | 'completed'    // target agent finished
  | 'synced_back'  // origin confirmed completion
  | 'failed';      // dispatch failed (target offline, rejected)
```

### Redis Channel/Stream Convention

```
task:dispatch:{targetTeamSlug}   — Stream for task dispatch (XADD / XREADGROUP)
task:status:{originTeamSlug}     — Pub/Sub for status sync (PUBLISH / SUBSCRIBE)
task:ack:{dispatchId}            — Stream for delivery acks
```

### Settings Schema

```typescript
interface TaskBusConfig {
  enabled: boolean;
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
}
```

Stored in `~/.hermit/settings.json` under key `taskBus`.

## Implementation Phases

### Phase 1: Types & Service Layer

**1.1 Extend TeamTask type** (`src/shared/types/team.ts`)

- Add `dispatchMeta?: DispatchMeta` field
- Add `DispatchMeta`, `DispatchStatus` types
- Add `TaskBusConfig` type

**1.2 Create TaskDispatchService** (`src/main/services/teams-mvp/TaskDispatchService.ts`)

Core interface:

```typescript
class TaskDispatchService {
  // Lifecycle
  start(): Promise<void>;       // connect Redis if configured, start listeners
  dispose(): void;              // cleanup

  // Agent-facing (called from MCP handler)
  listTeams(): Promise<DiscoverableTeam[]>;
  dispatchTask(fromTeam: string, task: Omit<TeamTask, 'id'>, targetTeam: string): Promise<DispatchResult>;
  onTaskCompleted(teamSlug: string, taskId: string): Promise<void>; // notify origin

  // Internal routing
  private handleLocalDispatch(fromTeam: string, task: TeamTask, targetTeam: string): Promise<void>;
  private handleRemoteDispatch(fromTeam: string, task: TeamTask, targetTeam: string): Promise<void>;
  private onRemoteDispatchReceived(dispatch: TaskDispatchPayload): Promise<void>;
  private onRemoteStatusUpdate(update: TaskStatusUpdate): Promise<void>;

  // Redis helpers
  private connectRedis(): Promise<void>;
  private startConsumers(): void;     // XREADGROUP loop per local team
  private subscribeStatus(): void;    // SUBSCRIBE task:status:{localTeam}
  private publishDispatch(targetTeam: string, payload: TaskDispatchPayload): Promise<void>;
  private publishStatus(originTeam: string, update: TaskStatusUpdate): Promise<void>;
}
```

**1.3 DiscoverableTeam type**

```typescript
interface DiscoverableTeam {
  slug: string;
  displayName: string;
  location: 'local' | 'remote';
  status: 'online' | 'offline';
  collaboration: boolean;
}
```

`listTeams()` merges:
- Local teams from `TeamWorkspaceService.listTeams()`
- Remote teams from Redis `task:teams` sorted set (each instance heartbeats its presence)

### Phase 2: MCP Tools

**2.1 Extend MCP server** (`src/main/server.ts` MCP handler)

Add two tools to the existing `hermit-tasks` MCP server:

| Tool | Input | Output |
|------|-------|--------|
| `list_teams` | (none) | `DiscoverableTeam[]` |
| `dispatch_task` | `targetTeam, subject, description?, prompt?` | `{ dispatchId, status }` |

Existing tools `claim_task`, `complete_task`, `list_tasks`, `create_task` remain unchanged.

`complete_task` gets a small hook: after completing a dispatched task, call `TaskDispatchService.onTaskCompleted()` to notify origin.

### Phase 3: Redis Transport

**3.1 Redis connection management**

- Use `ioredis` (add to optionalDependencies or dynamic import)
- Connect on `start()` if `taskBus` config present
- Two connections: one for publishing (dispatches + status), one for subscribing/consuming
- Graceful reconnect with exponential backoff (1s → 2s → 4s → max 30s)

**3.2 Team presence heartbeat**

Each instance periodically (every 30s) writes to Redis:

```
ZADD task:teams {timestamp} {teamSlug}
```

`listTeams()` reads `ZRANGE task:teams 0 -1`, filters stale entries (older than 90s).

**3.3 Dispatch flow (remote)**

```
Origin:
  XADD task:dispatch:{targetTeam} * payload <json>
  → wait for ack on task:ack:{dispatchId} (5s timeout)
  → if ack received: status = "received"
  → if timeout: status = "dispatched" (pending)

Target:
  XREADGROUP GROUP {teamSlug} {instanceId} BLOCK 5000 STREAMS task:dispatch:{teamSlug} >
  → parse payload
  → write to board.json as new TeamTask with dispatchMeta
  → XADD task:ack:{dispatchId} * {status: "received", remoteTaskId: "..."}
  → XACK

Status sync:
  Target complete_task() → PUBLISH task:status:{originTeam} {dispatchId, status: "completed", ...}
  Origin subscriber → update shadow task dispatchMeta.status
```

**3.4 Local fallback**

When no Redis configured, `dispatchTask()`:
- Reads target team's `board.json` directly
- Writes task with `dispatchMeta`
- Emits in-process event for SSE notification
- No Redis calls

### Phase 4: API Endpoints

Replace stubs in `server.ts`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/cross-team/send` | POST | Accept `CrossTeamSendRequest`, route through `TaskDispatchService` |
| `/api/cross-team/targets` | GET | Return `TaskDispatchService.listTeams()` |
| `/api/cross-team/outbox/:name` | GET | Return pending dispatches for a team |
| `/api/settings/task-bus` | GET | Return current task bus config |
| `/api/settings/task-bus` | PUT | Update task bus config (triggers reconnect) |

### Phase 5: UI

**5.1 Dispatch status on Kanban cards** (`KanbanTaskCard.tsx`)

- Badge showing dispatch status (dispatched → received → in_progress → completed)
- Color coding: yellow (dispatched), blue (received), green (completed), red (failed)
- Click badge to see dispatch detail (origin/target team, timestamps)

**5.2 Settings page** (existing settings UI)

- Task Bus section with Redis configuration form
- Host, port, password fields
- "Test Connection" button
- Enable/disable toggle

**5.3 Task detail** (task detail panel)

- Show dispatch history when `dispatchMeta` present
- Origin team, target team, timestamps, status chain

## File Change Summary

| File | Action | Lines |
|------|--------|-------|
| `src/shared/types/team.ts` | Modify | +30 (DispatchMeta, DispatchStatus, TaskBusConfig, DiscoverableTeam) |
| `src/main/services/teams-mvp/TaskDispatchService.ts` | Create | +350 (core service) |
| `src/main/server.ts` | Modify | +80 (MCP tools + API endpoints) |
| `src/renderer/components/team/kanban/KanbanTaskCard.tsx` | Modify | +40 (dispatch badge) |
| `src/renderer/components/team/tasks/TaskDetailPanel.tsx` | Modify | +30 (dispatch history) |
| `src/renderer/components/settings/TaskBusSettings.tsx` | Create | +80 (Redis config UI) |
| `package.json` | Modify | +1 (ioredis optional dep) |
| **Total** | | **~610 lines** |

## Agent Dispatch Rules

Agents need guidance on when to dispatch vs. do it themselves.

### v1: Hardcoded Default Rules

Injected via MCP tool description on `list_teams` and `dispatch_task`:

```
When to dispatch:
- Task requires access to a different codebase/project
- Task explicitly mentions another team's domain or ownership
- Task is blocked by work owned by another team
- Task requires expertise the current team doesn't have

Do NOT dispatch:
- Task is within current team's project scope
- Task can be completed with available tools
- Task is a small change (< estimated 5 min)
```

### v2: User-Configurable Rules

File: `~/.hermit/dispatch-rules.md` (Markdown, natural language)

- Read by `TaskDispatchService` on startup
- Injected into `dispatch_task` MCP tool description
- Falls back to hardcoded defaults if file missing
- Hot-reload on file change

## Execution Order

1. Types (`team.ts`) — no dependencies
2. `TaskDispatchService` — depends on types
3. MCP tools + dispatch rules injection — depends on service
4. API endpoints — depends on service
5. UI — depends on API being wired
6. Integration test — end-to-end dispatch flow

## Testing Strategy

- Unit: `TaskDispatchService` with mocked Redis (`ioredis-mock`)
- Unit: Local dispatch (no Redis) against temp directory
- Integration: Two Hermit instances sharing a Redis (docker)
- E2E: Agent calls `list_teams`, dispatches, target completes, status syncs back

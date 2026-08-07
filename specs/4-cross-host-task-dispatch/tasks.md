# Tasks: Cross-Host Team Task Dispatch

**Feature**: Cross-Host Team Task Dispatch
**Branch**: `4-cross-host-task-dispatch`
**Plan**: `specs/4-cross-host-task-dispatch/plan.md`

## User Stories

| Story | Description | Priority |
|-------|-------------|----------|
| US1 | Agent discovers and dispatches task to another team (local) | P1 |
| US2 | Agent dispatches task to a remote team via Redis | P2 |
| US3 | Status syncs back from remote team to origin | P3 |
| US4 | Offline dispatch with queue and retry | P4 |
| US5 | UI shows dispatch status on kanban and task detail | P5 |
| US6 | Settings page for Redis task bus configuration | P6 |

## Implementation Strategy

MVP = US1 (local dispatch only, no Redis). Each subsequent story adds one capability incrementally. US1-US3 form the core loop; US4-US6 are polish.

---

## Phase 1: Setup

- [ ] T001 Add `ioredis` to `optionalDependencies` in `package.json`
- [ ] T002 Create `src/main/services/teams-mvp/TaskDispatchService.ts` with class skeleton and lifecycle methods (`start`, `dispose`)

---

## Phase 2: Foundation — Types

- [ ] T003 [P] Add `DispatchMeta`, `DispatchStatus` types to `src/shared/types/team.ts` — fields: dispatchId, originTeam, targetTeam, status, dispatchedAt, receivedAt?, completedAt?, remoteTaskId?
- [ ] T004 [P] Add `dispatchMeta?: DispatchMeta` field to `TeamTask` interface in `src/shared/types/team.ts`
- [ ] T005 [P] Add `DiscoverableTeam` type to `src/shared/types/team.ts` — fields: slug, displayName, location ('local'|'remote'), status ('online'|'offline'), collaboration
- [ ] T006 [P] Add `TaskBusConfig` type to `src/shared/types/team.ts` — fields: enabled, redis { host, port, password?, db? }
- [ ] T007 [P] Add payload types `TaskDispatchPayload`, `TaskStatusUpdate`, `TaskAckPayload` to `src/shared/types/team.ts`
- [ ] T008 Add barrel exports for all new types in `src/shared/types/team.ts`

---

## Phase 3: US1 — Local Task Dispatch (MVP)

**Goal**: Agent can list local teams and dispatch a task to another local team via MCP tools.
**Test**: Two teams on same Hermit instance. Agent A calls `list_teams`, sees Team B. Calls `dispatch_task("team-b", "Fix bug")`. Task appears on Team B's board with dispatch status badge.

- [ ] T009 [US1] Implement `listTeams()` in `TaskDispatchService` — read local teams from `TeamWorkspaceService.listTeams()`, map to `DiscoverableTeam[]` with `location: 'local'` in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T010 [US1] Implement `dispatchTask()` local path in `TaskDispatchService` — validate target exists and is not source team, generate `dispatchId` (UUID), create `TeamTask` with `dispatchMeta`, write to target team's `board.json` via `TeamWorkspaceService`, emit SSE event in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T011 [US1] Add `list_teams` MCP tool to hermit-tasks server — calls `TaskDispatchService.listTeams()`, returns `DiscoverableTeam[]`, includes hardcoded dispatch rules in tool description in `src/main/server.ts`
- [ ] T012 [US1] Add `dispatch_task` MCP tool to hermit-tasks server — accepts targetTeam, subject, description?, prompt?, calls `TaskDispatchService.dispatchTask()`, returns dispatchId + status in `src/main/server.ts`
- [ ] T013 [US1] Wire `TaskDispatchService` into Hermit main process lifecycle — instantiate on app start, pass to MCP handler and API routes, dispose on app quit in `src/main/index.ts`

---

## Phase 4: US2 — Remote Dispatch via Redis

**Goal**: When Redis is configured, agent can dispatch tasks to teams on other Hermit instances.
**Test**: Two Hermit instances sharing a Redis. Agent on A dispatches to team on B. Task appears on B's board within 5 seconds.

- [ ] T014 [US2] Implement `connectRedis()` in `TaskDispatchService` — dynamic import `ioredis`, create two connections (publish + subscribe/consume), reconnect with exponential backoff in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T015 [US2] Implement team presence heartbeat — every 30s `ZADD task:teams {timestamp} {teamSlug}` for each local team, start in `start()` in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T016 [US2] Extend `listTeams()` to include remote teams — `ZRANGE task:teams 0 -1`, filter stale entries (>90s), merge with local teams in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T017 [US2] Implement `handleRemoteDispatch()` — `XADD task:dispatch:{targetTeam}` with `TaskDispatchPayload`, create consumer group if not exists, wait for ack with 5s timeout in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T018 [US2] Implement `startConsumers()` — `XREADGROUP GROUP {teamSlug} {instanceId} BLOCK 5000` loop per local team, on message: write task to `board.json`, send ack, emit SSE in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T019 [US2] Update `dispatchTask()` routing — check if target is local (direct write) or remote (XADD via Redis) in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T020 [US2] Add `dispose()` cleanup — stop consumers, unsubscribe, disconnect Redis, clear heartbeat timer in `src/main/services/teams-mvp/TaskDispatchService.ts`

---

## Phase 5: US3 — Status Sync

**Goal**: When remote team completes a dispatched task, origin team sees the update.
**Test**: Team B completes dispatched task. Team A's shadow task updates to "completed" status.

- [ ] T021 [US3] Implement `onTaskCompleted()` in `TaskDispatchService` — check task's `dispatchMeta`, if present `PUBLISH task:status:{originTeam}` with `TaskStatusUpdate` payload in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T022 [US3] Hook `onTaskCompleted()` into `complete_task` MCP tool — after task status set to completed, call `TaskDispatchService.onTaskCompleted()` in `src/main/server.ts`
- [ ] T023 [US3] Implement `subscribeStatus()` — `SUBSCRIBE task:status:{localTeam}` per local team, on message: update shadow task's `dispatchMeta.status`, emit SSE event in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T024 [US3] Handle `in_progress` status sync — when remote team's agent calls `claim_task`, publish status update so origin sees "in_progress" in `src/main/server.ts`

---

## Phase 6: US4 — Offline Queue & Retry

**Goal**: Dispatched tasks are never lost. If target is offline, queue and retry on reconnect.
**Test**: Dispatch to offline team. Task queued locally. Target comes online, task delivered.

- [ ] T025 [US4] Implement outbound dispatch queue — write failed/pending dispatches to `~/.hermit/dispatch-queue/{dispatchId}.json` in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T026 [US4] Implement retry on reconnect — on Redis connect, scan queue directory, retry each pending dispatch, remove on success in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T027 [US4] Implement `GET /api/cross-team/outbox/:name` endpoint — read queue directory, return pending dispatches for team in `src/main/server.ts`

---

## Phase 7: US5 — UI Dispatch Status

**Goal**: Users see dispatch status on kanban cards and task detail without manual refresh.
**Test**: Dispatched task shows yellow badge "Dispatched → Beta". On completion, badge turns green "Completed".

- [ ] T028 [P] [US5] Add dispatch status badge to `KanbanTaskCard.tsx` — render colored badge based on `task.dispatchMeta.status` (yellow=dispatched, blue=received, green=completed, red=failed), show origin/target team names in `src/renderer/components/team/kanban/KanbanTaskCard.tsx`
- [ ] T029 [P] [US5] Add dispatch history section to task detail panel — when `dispatchMeta` present, show origin team, target team, dispatch ID, timestamps, status chain in `src/renderer/components/team/tasks/TaskDetailPanel.tsx`
- [ ] T030 [US5] Wire SSE events for dispatch status changes — listen for dispatch-status-change events, update task in store, re-render kanban in `src/renderer/store/slices/teamSlice.ts`

---

## Phase 8: US6 — Settings & Configuration

**Goal**: Users can configure Redis connection from the settings UI.
**Test**: Open settings, enter Redis host/port, click Test Connection, see success. Toggle enables/disables cluster mode.

- [ ] T031 [P] [US6] Create `TaskBusSettings.tsx` — Redis config form (host, port, password, db), enable/disable toggle, "Test Connection" button, save triggers reconnect in `src/renderer/components/settings/TaskBusSettings.tsx`
- [ ] T032 [US6] Implement `GET /api/settings/task-bus` endpoint — read from `~/.hermit/settings.json` taskBus key in `src/main/server.ts`
- [ ] T033 [US6] Implement `PUT /api/settings/task-bus` endpoint — validate config, save to settings.json, trigger `TaskDispatchService` reconnect in `src/main/server.ts`
- [ ] T034 [US6] Implement "Test Connection" — attempt Redis connect with provided config, return success/failure with latency in `src/main/server.ts`
- [ ] T035 [US6] Add TaskBusSettings section to existing settings page in `src/renderer/components/settings/SettingsPage.tsx`

---

## Phase 9: API Endpoints & Polish

- [ ] T036 Replace `POST /api/cross-team/send` stub with real implementation routing through `TaskDispatchService` in `src/main/server.ts`
- [ ] T037 Replace `GET /api/cross-team/targets` stub with `TaskDispatchService.listTeams()` in `src/main/server.ts`
- [ ] T038 Add error handling for dispatch failures — target not found, collaboration disabled, Redis disconnected — return appropriate HTTP status codes and error messages in `src/main/services/teams-mvp/TaskDispatchService.ts`
- [ ] T039 Run `pnpm typecheck 2>&1 | tail -20` and fix any type errors introduced by new types
- [ ] T040 Run `pnpm build 2>&1 | tail -20` and verify clean build

---

## Dependency Graph

```
T001 → T014 (ioredis needed for Redis)
T002 → T009 (service skeleton before implementation)
T003-T008 → T009 (types needed by service)

US1: T009 → T010 → T011 + T012 (parallel) → T013
US2: T013 → T014 → T015 + T016 (parallel) → T017 + T018 → T019 → T020
US3: T018 → T021 → T022, T023 + T024 (parallel)
US4: T017 → T025 → T026 → T027
US5: T013 → T028 + T029 (parallel), T023 → T030
US6: T014 → T032 + T033 + T034 (parallel) → T031 → T035
```

## Parallel Opportunities

| Phase | Parallel Tasks | Reason |
|-------|---------------|--------|
| Foundation | T003, T004, T005, T006, T007, T008 | All type definitions, independent |
| US1 MCP | T011, T012 | Two MCP tools, different handlers |
| US5 UI | T028, T029 | Badge and detail panel, different components |
| US6 API | T032, T033, T034 | Three endpoints, independent |
| Polish | T036, T037, T038 | Independent endpoint fixes |

## Suggested MVP

**US1 only (T001-T013)**: Local dispatch with MCP tools. No Redis, no remote teams. Agents can discover local teams and dispatch tasks. ~400 lines, independently testable on a single machine.

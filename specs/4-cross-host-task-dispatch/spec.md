# Feature Specification: Cross-Host Team Task Dispatch

## Overview

Enable teams running on different machines to exchange tasks with real-time status synchronization. A lead or team member can dispatch a task to another team (local or remote), and both sides see the task lifecycle update live — from dispatch through completion.

## Problem Statement

Hermit teams currently operate in isolation on a single host. The existing `dispatchTask` method only sends a plain-text message via cc-connect to a local team, without synchronizing the actual task object or tracking its status after dispatch. Users managing multiple teams across different machines have no way to assign work between them, see cross-team progress, or receive completion notifications.

This limits Hermit to single-machine workflows and prevents the "CTO with a distributed AI engineering team" vision from scaling across hosts.

## User Scenarios & Testing

### Primary Scenario: Dispatch a task to a remote team
1. User opens the kanban board for Team A
2. User clicks a task, selects "Dispatch to team", and chooses Team B (running on another host)
3. The task appears on Team B's kanban board with a "dispatched" badge
4. Team B's agent picks up the task and changes status to in_progress — Team A sees the update in real-time
5. Team B completes the task — Team A sees the status change to completed and receives a notification

### Alternative Scenario: Same-host dispatch
1. User dispatches a task from Team A to Team C on the same machine
2. The task transfer happens instantly without relay — direct local write
3. Status sync works identically to the remote case

### Alternative Scenario: Offline dispatch
1. User dispatches a task to a remote team that is currently unreachable
2. The task is queued locally with "dispatch pending" status
3. When the remote team comes online, the dispatch is automatically retried
4. Once received, normal status sync begins

### Edge Cases
- Dispatch to a team that no longer exists (show error, allow reassignment)
- Concurrent status updates from both teams (last-write-wins with conflict detection)
- Task dispatched multiple times to different teams (track full dispatch chain)
- Network interruption during active sync (reconnect and reconcile states)
- Task completed on remote team while origin team is offline (sync on reconnect)

## Functional Requirements

### FR-1: Task Dispatch from Kanban
Users can dispatch any task to another team (local or remote) from the kanban board via a "Dispatch to team" action. The action presents a list of available teams with their connection status.

### FR-2: Task Object Transfer
When a task is dispatched, the full task object (subject, description, prompt, attachments, task refs) is transferred to the receiving team — not just a message notification.

### FR-3: Dispatch State Machine
Tasks follow a dispatch-aware state lifecycle:
- `local` → task exists only on the originating team (default)
- `dispatched` → task has been sent to a target team, awaiting acknowledgment
- `received` → target team has acknowledged and created the task locally
- `in_progress` → target team is actively working on the task
- `completed` → target team has finished the task
- `synced_back` → completion status has been confirmed on the originating team

### FR-4: Real-Time Status Synchronization
Status changes on the receiving team propagate to the originating team in real-time. The originating team's kanban board reflects the remote task's current status without manual refresh.

### FR-5: Origin and Target Tracking
Each dispatched task carries `originTeam` and `targetTeam` metadata. The originating team retains a lightweight reference (shadow task) pointing to the remote task, and the receiving team sees the origin context.

### FR-6: Offline Queue and Retry
When the target team is unreachable, dispatched tasks are stored in a local outbound queue. The system periodically retries delivery. Queued tasks show a "pending dispatch" indicator on the kanban board.

### FR-7: Dispatch History
Users can view the full dispatch chain for any task — which teams it passed through, when, and what each team did. This is visible in the task detail view.

### FR-8: Bidirectional Comments
Team members on both the origin and target teams can add comments on a dispatched task. Comments are synchronized between teams so both sides have full context.

### FR-9: Team Discovery
The system provides a list of dispatchable teams, showing whether each team is local or remote, and its current connectivity status. Only teams with collaboration enabled appear in the list.

### FR-10: Notification on Status Change
The originating team receives a notification when a dispatched task changes status (received, in_progress, completed) on the remote team.

## Non-Functional Requirements

### NFR-1: Latency
Status updates between teams on the same local network should propagate within 2 seconds. Cross-internet updates should propagate within 5 seconds under normal conditions.

### NFR-2: Reliability
Dispatched tasks are never lost. If a transfer fails, the task remains in the outbound queue until successful delivery or manual cancellation.

### NFR-3: Security
Cross-host communication is encrypted. Only teams within the same Hermit workspace (sharing a workspace key) can exchange tasks.

## Success Criteria

| ID   | Criterion                                                     | Measure                                                    |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| SC-1 | Users can dispatch a task to a remote team from the kanban UI | Task appears on the remote team's board within 5 seconds   |
| SC-2 | Status changes propagate between hosts                        | Remote status visible on origin board within 5 seconds     |
| SC-3 | Offline dispatches are never lost                             | All queued dispatches delivered when connectivity restored  |
| SC-4 | Dispatch history is traceable                                 | Full chain visible in task detail for any dispatched task   |
| SC-5 | Same-host dispatch feels instant                              | Task transfer completes in under 1 second on local machine  |
| SC-6 | Users understand task state at a glance                       | Dispatch status badge clearly shows current state           |

## Assumptions

- The existing cc-connect infrastructure will serve as the relay layer for cross-host communication, extended to support task objects (not just messages)
- Each Hermit instance can reach the cc-connect relay or has a direct connection to the target host
- Teams opt-in to cross-team collaboration via the existing `collaboration` flag in team manifests
- Task IDs are globally unique (UUID-based), so no ID collisions occur across teams
- The relay server does not need to store task data long-term — it routes and buffers transiently

## Dependencies

- cc-connect relay server with task routing capability
- Existing `CrossTeamSendRequest` / `CrossTeamMessage` infrastructure
- Kanban board UI with dispatch action integration
- Notification system for dispatch status alerts

## Out of Scope

- Task re-dispatch (forwarding a received task to a third team) — deferred to a future iteration
- Task version control or conflict resolution beyond last-write-wins
- Authentication/authorization between different Hermit workspaces — assumes same workspace trust
- Automatic task splitting or load balancing across teams
- File attachment transfer for cross-host dispatch (message-only for v1, attachments in v2)

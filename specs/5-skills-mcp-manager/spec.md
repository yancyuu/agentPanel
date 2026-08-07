# Feature Specification: Skills & MCP Manager

## Overview

Provide a unified visual interface for managing MCP servers and Skills across all scopes (global, user, project, team). Replace manual JSON editing with an intuitive dashboard that covers installation, configuration, health monitoring, and lifecycle management for both MCP servers and agent skills.

Also includes **Team Usage Reporting**: team members push their harness activity to Redis, and everyone in the team can view aggregated metrics in Hermit's built-in dashboard.

## Problem Statement

Managing MCP servers and Skills in Hermit currently requires editing `settings.json` files manually or navigating scattered UI elements. Users cannot easily see what's installed, what's running, or what's broken. Key pain points:

- MCP server configuration lives in different `settings.json` files (global, project, team) with no unified view
- There is no clear visibility into which MCP servers are healthy, which have connection errors, or which are idle
- Skills come from multiple sources (Git repos, local directories, runtimes like Claude/Cursor/Codex) with no central management
- No way to see which skills each team actually has access to, or to toggle skills per team
- Debugging MCP failures requires digging through logs instead of seeing status inline

Users need a single place to see, configure, and troubleshoot their entire MCP and Skills setup.

Additionally, team leads have no visibility into how team members use their harnesses — what files they're editing, what projects they work on, and what the AI is doing. This makes it difficult to understand team productivity, audit work, and coordinate across the team.

## User Scenarios & Testing

### Primary Scenario: MCP Server lifecycle management
1. User opens the Skills & MCP Manager from the sidebar
2. The dashboard shows all installed MCP servers grouped by scope (global, user, project, team)
3. Each server card shows its name, status (connected/error/idle), and scope badge
4. User clicks "Add Server" — chooses from the catalog or enters a custom URL/command
5. User selects the scope and configures environment variables
6. Server installs and connects — status turns green
7. User can see the tools the server exposes and test a tool call

### Alternative Scenario: Skill source management
1. User switches to the Skills tab in the manager
2. Sees all installed skills grouped by source (Hermit, Claude, Cursor, project-local)
3. Clicks "Add Source" to register a new Git repository as a skill source
4. Skills from the new source appear after sync
5. User can enable/disable individual skills per team or globally

### Alternative Scenario: Team-specific MCP configuration
1. User selects a team from the team filter
2. Sees which MCP servers are injected for that team (including the built-in `hermit-tasks`)
3. Adds a project-specific MCP server for that team only
4. The team's agent picks up the new server on next session start

### Edge Cases
- MCP server fails to connect — error state with diagnostic info and retry button
- Conflict between global and project-scoped server with the same name — warning with resolution options
- Skill source becomes unreachable — stale indicator with last-known-good state
- User tries to remove a built-in server (hermit-tasks) — prevented with explanation
- Multiple teams sharing a project MCP config — changes propagate to all affected teams

## Functional Requirements

### FR-1: Unified MCP Dashboard
A single view showing all MCP servers across all scopes. Each server displays its name, transport type (HTTP/SSE, stdio), scope, connection status, and the tools it provides.

### FR-2: MCP Server Installation
Users can install MCP servers from a built-in catalog or by providing custom server specifications (URL for HTTP/SSE, command for stdio). Installation supports scope selection (global, user, project, team).

### FR-3: MCP Server Configuration
Users can edit MCP server settings (URL, environment variables, command arguments) through a form interface. Changes are validated before saving.

### FR-4: MCP Health Monitoring
The dashboard continuously monitors MCP server connectivity. Servers show real-time status indicators: connected (green), error (red with error message), idle (gray), or installing (spinner). Users can trigger manual health checks.

### FR-5: MCP Server Removal
Users can remove MCP servers (except built-in system servers). Removal shows which teams or projects are affected before confirming.

### FR-6: Skills Dashboard
A dedicated view showing all available skills grouped by source and runtime. Each skill displays its name, description, trigger conditions, and which teams have it enabled.

### FR-7: Skill Source Management
Users can add, remove, and refresh skill sources (Git repositories). The system syncs skill definitions from sources and shows sync status (up-to-date, syncing, error).

### FR-8: Skill Toggle per Team
For each team, users can enable or disable individual skills. Disabled skills do not appear in that team's agent sessions.

### FR-9: Team MCP Overrides
Users can add or remove MCP servers specific to a team, beyond what the global and project scopes provide. Team-level additions and overrides are clearly labeled.

### FR-10: Tool Browser
For any connected MCP server, users can browse the list of available tools, see each tool's input schema, and optionally test a tool invocation from the UI.

---

## Team Usage Reporting (MCP Manager Extension)

### Overview

A simple on/off switch enables team-wide usage reporting:
- **ON**: All team members push their activity to shared Redis; everyone sees the aggregated dashboard
- **OFF**: No reporting, no visibility

No per-user permissions — once reporting is enabled, all team members can see all activity.

### Primary Scenario: Enable reporting
1. Team member opens Skills & MCP Manager → 上报数据 (Reporting) tab
2. Toggle "开启上报" to ON
3. That's it — all members' activity now flows to Redis

### Primary Scenario: View team activity
1. Any team member opens the Reporting tab
2. Sees: file activity heatmap, token trends, session counts by member
3. Filter by date range, project, harness
4. Click member to see their session list

### Primary Scenario: Member's reporter works
1. Member runs Claude Code as usual
2. Reporter daemon (background process) parses `~/.claude/projects/*.jsonl` every 5 minutes
3. Reporter extracts: file operations (read/write/edit), token usage (input/output/cache), session metadata
4. Reporter pushes to Redis with team prefix
5. No additional setup needed — once reporting is enabled, it just works

### Alternative Scenario: Member offline
1. Member laptop offline — reporter accumulates locally
2. When back online, reporter pushes buffered metrics
3. No data lost

### Edge Cases
- Redis unavailable — reporter retries with backoff, logs errors
- Duplicate metrics — reporter tracks last-pushed timestamp, only sends new data
- Very large session JSONL (> 1MB) — skip or parse in chunks
- New team member — automatically included in reporting once enabled

### FR-11: Reporting Toggle UI
Skills & MCP Manager → 上报数据 tab:
- Large toggle: "开启上报" / "关闭上报"
- When ON: shows current status (connected, last push time)
- When ON: shows brief metrics preview (total tokens today, active members)
- No configuration needed (uses existing team Redis)

### FR-12: Reporter Daemon (per member machine)
Lightweight Python daemon:
- Runs as launchd agent (macOS) or systemd service (Linux)
- Reads no configuration — just pushes to team Redis
- Parses Claude Code JSONL files (reuses CCPal parsing logic)
- Extracts file operations, token usage, session metadata
- Pushes to Redis every 5 minutes
- Tracks last-push timestamp to avoid duplicates
- Logs to `~/.hermit/reporter.log`

### FR-13: Supported Harness Parsers

| Harness | Location | Format |
|---------|----------|--------|
| Claude Code | `~/.claude/projects/*.jsonl` | JSONL (CCPal-compatible) |
| Codex | `~/.codex/sessions/*.jsonl` | JSONL (future) |
| OpenCode | `~/.opencode/sessions/*.jsonl` | JSONL (future) |

Parser interface (Python):
```python
class HarnessParser:
    harness: str
    def scan_paths(self) -> list[str]: ...
    def parse_session(self, path: str) -> SessionRecord | None: ...
    def parse_file_activity(self, session_path: str) -> list[FileActivity]: ...
```

### FR-14: Redis Data Schema

All keys prefixed by team: `team:{teamId}:reporting:...`

```
# Token counts by member by date
team:{teamId}:tokens:{member}:{YYYY-MM-DD}
  → Hash: { input: N, output: N, cache: N }

# File activity by member by project
team:{teamId}:files:{member}:{project}
  → Sorted Set: {timestamp} → file_path

# Session count by member
team:{teamId}:sessions:{member}
  → Counter (INCR on each session)

# Active members (heartbeat)
team:{teamId}:active
  → Set: member names, refreshed on each push

# Last push timestamp
team:{teamId}:last_push:{member}
  → String: unix timestamp
```

### FR-15: Hermit Dashboard UI

Reporting tab shows:
- **Token trend chart**: daily tokens by member (bar chart, last 7/30 days)
- **File activity**: recent files touched by project
- **Member list**: tokens, sessions, last active per member
- **Filter**: date range, harness

No separate Grafana needed — native Hermit UI.

### FR-16: Privacy Indicator
When reporting is ON:
- Small "📊 上报中" badge in Hermit status bar
- Tooltip: "团队使用情况已开启，所有成员可见"

## Non-Functional Requirements

### NFR-1: Responsiveness
The dashboard loads within 2 seconds. Health check results appear within 5 seconds of opening. Skill sync completes within 10 seconds for typical repositories.

### NFR-2: Safety
Configuration changes require confirmation when affecting multiple teams. Built-in servers cannot be accidentally removed. A rollback mechanism allows reverting to the last known-good configuration.

### NFR-3: Privacy
- Members see "📊 上报中" indicator when reporting is enabled
- All team members can see all activity (no individual opt-out)
- Only file paths and token counts stored (no chat content)
- Team isolation via Redis key prefix

### NFR-4: Reliability
- Reporter daemon must not impact harness performance
- Reporter must survive network failures gracefully (local buffer)
- No data loss: all metrics eventually pushed (at-least-once)

### NFR-5: Performance
- Reporter scanning should not exceed 1% CPU when idle
- Push interval: 5 minutes (configurable)
- Dashboard must load within 2 seconds for 50 members, 30 days of data

### NFR-6: Zero Configuration
- Once reporting is enabled, no further setup needed
- Reporter auto-discovers team Redis from Hermit settings
- No manual Redis configuration for members

### NFR-7: Extensibility
- New harnesses can be added by implementing `HarnessParser` interface
- No hardcoded assumptions about specific harness implementation

## Success Criteria

| ID   | Criterion                                                        | Measure                                                       |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| SC-1 | Users can install a new MCP server without editing JSON files    | Complete install flow via UI in under 30 seconds              |
| SC-2 | Server health is visible at a glance                             | Status indicators update within 5 seconds of state change     |
| SC-3 | Skills from all sources appear in one view                       | All registered sources visible with sync status               |
| SC-4 | Team-specific MCP changes take effect without restart            | New server available to team agent on next session turn        |
| SC-5 | Users can diagnose broken MCP servers from the dashboard         | Error messages and retry actions visible inline               |
| SC-6 | Configuration changes are safe                                   | Destructive actions require confirmation; built-ins protected  |
| SC-7 | Reporting toggle enables team-wide visibility with one click    | Toggle ON → all members see dashboard within 5 minutes         |
| SC-8 | Reporter daemon runs in background on member's machine           | No visible impact on Claude Code performance                  |
| SC-9 | Metrics appear in Hermit dashboard within 5 min of activity     | Dashboard shows new data after reporter push cycle             |
| SC-10 | Token and file activity charts render correctly                | Bar charts and lists show accurate aggregated data             |
| SC-11 | Member can see reporting is active                              | "📊 上报中" badge visible in Hermit status bar                 |
| SC-12 | Reporter handles offline gracefully                             | Buffered metrics sync when connection restored                 |

## Assumptions

- The existing `McpServersPanel`, `McpServerCard`, and `extensionsSlice` will serve as the foundation, extended rather than replaced
- MCP server catalog data comes from an external registry (already implemented via `/api/extensions/mcp/browse`)
- Skills follow the existing SKILL_ROOT_DEFINITIONS structure with Hermit, Claude, Cursor, Agents, and Codex roots
- The built-in `hermit-tasks` MCP server is always present and cannot be removed
- Team shares a Redis instance with task dispatch
- Members trust each other (internal team, no privacy concerns about visibility)
- Reporter daemon can be installed via a simple script (no complex deployment)

## Dependencies

- Existing MCP catalog browsing API (`/api/extensions/mcp/*`)
- Existing skill source and projection system
- Team manifest and settings.json management
- Health monitoring infrastructure (to be extended)
- Shared Redis instance (already used for task dispatch)
- Reporter daemon (Python, based on CCPal parsing logic)
- `redis` Python library for data push

## Out of Scope

- MCP server creation/development tools (users bring their own servers)
- Skill authoring or editing workflow (manage existing skills only)
- Marketplace or rating system for MCP servers and skills
- Automatic MCP server version updates
- Cross-host MCP server synchronization
- Chat content storage (viewed in native Hermit session list)
- Individual user opt-out (team-wide visibility when enabled)
- External Grafana/Prometheus (native Hermit dashboard)
- Multi-tenant deployment (single team at a time)

## Extensibility: Future Data Sources

This feature is designed to be extensible. Future phases may add:

### FR-17: Additional Metrics (Future)
- Git activity (commits, branches)
- Tool usage breakdown
- Model cost estimation

### Implementation Guidance for Extensions

New metrics should follow the same pattern:
1. Add parser method for the data type
2. Define new Redis key patterns with team prefix
3. Increment metrics in reporter main loop
4. Add new panels to Hermit dashboard UI

No schema migrations needed — Redis handles all data flexibly.
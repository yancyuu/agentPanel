# Tasks: Task Bus Usage Telemetry

## Phase 1: Shared Types And Contracts

### Task 1.1: Define Metadata-Only Types
- [ ] Add `LocalSessionUsage`, `UsageReport`, `UsageTelemetryConfig`, `UsageDoctorResult`
- [ ] Ensure report payload has no transcript, prompt, response, file content, or tool args
- [ ] Add validation helpers for metadata-only reports

### Task 1.2: Document Privacy Contract
- [ ] Add explicit allowlist/denylist comments near report types
- [ ] Add tests that reject content-bearing fields

## Phase 2: Claude Code Local Parser

### Task 2.1: Session File Discovery
- [ ] Create `ClaudeCodeSessionParser`
- [ ] Scan `~/.claude/projects/**/*.jsonl`
- [ ] Do not modify source JSONL
- [ ] Track file path hash, mtime, size

### Task 2.2: JSONL Metadata Extraction
- [ ] Parse user/assistant messages
- [ ] Extract session start/end/update time
- [ ] Extract message count
- [ ] Extract input/output/cache token counts where present
- [ ] Count tool calls by tool name only
- [ ] Extract model names where present
- [ ] Skip malformed partial lines

### Task 2.3: Parser Tests
- [ ] Add fixtures for Claude Code JSONL
- [ ] Test partial/corrupt line handling
- [ ] Test no prompt/response text in output
- [ ] Test token/tool aggregation

## Phase 3: Local Session Index

### Task 3.1: SessionIndexRepository
- [ ] Create `~/.hermit/session-index/`
- [ ] Persist `sessions.json`
- [ ] Persist `stats.json`
- [ ] Persist `state.json`
- [ ] Persist `diagnostics.json`

### Task 3.2: Incremental Scan
- [ ] Use mtime/size state to avoid full reparse
- [ ] Rebuild changed session entries
- [ ] Remove stale entries when source file disappears only from derived index

### Task 3.3: Usage Aggregation
- [ ] Aggregate by member/machine
- [ ] Aggregate by day/week
- [ ] Aggregate by harness
- [ ] Aggregate tool call counts
- [ ] Compute active days and session counts

## Phase 4: Queue And Task Bus Integration

### Task 4.1: UsageReportQueue
- [ ] Append metadata reports to `queue.jsonl`
- [ ] Deduplicate by `sessionIdHash + updatedAt`
- [ ] Mark acknowledged entries
- [ ] Track queue size and last flush time

### Task 4.2: Task Bus Enabled Hook
- [ ] When Task Bus is enabled, schedule usage scan
- [ ] When Task Bus is disabled, stop report flushing
- [ ] Keep local index available even when disabled
- [ ] Update Task Bus settings copy to explain telemetry behavior

### Task 4.3: Report Transport
- [ ] Add `POST /api/team-usage/reports`
- [ ] Accept only metadata allowlist fields
- [ ] Store aggregate records for dashboard
- [ ] Reject content fields

## Phase 5: Doctor

### Task 5.1: CLI Doctor Command
- [ ] Add `openhermit doctor`
- [ ] Check `~/.claude/projects` existence
- [ ] Check parser sample
- [ ] Check local index writability
- [ ] Check queue length
- [ ] Check last scan time
- [ ] Check Task Bus enabled state
- [ ] Print actionable remediation

### Task 5.2: Doctor API
- [ ] Add `GET /api/session-intelligence/doctor`
- [ ] Return structured `UsageDoctorResult`

## Phase 6: Dashboard

### Task 6.1: API
- [ ] Add `GET /api/team-usage/dashboard`
- [ ] Support date range filter
- [ ] Support harness filter
- [ ] Support member filter

### Task 6.2: UI
- [ ] Add team usage dashboard section
- [ ] Show token totals by member
- [ ] Show session counts
- [ ] Show active days
- [ ] Show daily/weekly token trend
- [ ] Show tool call counts
- [ ] Show no transcript text

## Phase 7: Local MCP Tools

### Task 7.1: Local Stats Tool
- [ ] Add `session_usage_stats`
- [ ] Return local-only usage stats

### Task 7.2: Local Search Tools
- [ ] Add `session_recent`
- [ ] Add `session_search`
- [ ] Add `session_get_transcript`
- [ ] Keep transcript tools local-only

## Out Of Scope V1

- [ ] Codex parser
- [ ] OpenCode parser
- [ ] Transcript upload
- [ ] File content collection
- [ ] Full project path upload
- [ ] Shell argument upload
- [ ] PostgreSQL configuration UI
- [ ] Enterprise data warehouse

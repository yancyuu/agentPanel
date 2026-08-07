# Feature Specification: Task Bus Usage Telemetry

## Overview

When Task Bus is enabled, Hermit should automatically collect and report non-content usage metadata from local AI harness sessions. The goal is to let a team lead understand token consumption, activity, and operational health without collecting prompts, answers, files, shell arguments, or raw transcripts.

This feature borrows the useful local-first parts of CCPal:

- Read Claude Code JSONL sessions from `~/.claude/projects/**/*.jsonl`
- Build local usage stats: sessions, messages, tokens, active days, tool counts
- Provide doctor/self-check tooling
- Keep raw conversation data local by default

It deliberately does not copy CCPal's transcript-sharing behavior for team reporting.

## Product Boundary

### Enabled By

Task Bus settings drive usage telemetry:

- If `任务总线 / Enable Task Bus` is off: no team telemetry is collected or uploaded.
- If Task Bus is on: Hermit collects local non-content usage metadata and makes it available to the team usage dashboard.
- Transcript sharing remains a separate explicit opt-in and is out of scope for v1.

### Default Data Collected

Allowed by default:

- member identifier
- machine name
- harness type
- hashed session id
- session start/end time
- active duration
- input/output/cache token counts
- message count
- tool call counts by tool name only
- model name if present
- high-level project label if configured by user
- project hash if project grouping is enabled

Not collected by default:

- user prompts
- assistant responses
- raw JSONL content
- file content
- file paths
- shell command arguments
- tool arguments
- full project path
- attachment content
- screenshots/images

## User Scenarios & Testing

### Scenario 1: Team lead enables Task Bus

1. Team lead opens Settings -> Task Bus.
2. Team lead enables Task Bus.
3. UI explains that non-content usage metadata will be collected for team reporting.
4. Hermit starts collecting local usage metadata from supported harnesses.
5. Team usage dashboard shows members' token usage and activity.

### Scenario 2: Member runs Claude Code normally

1. Member uses Claude Code as usual.
2. Hermit reads `~/.claude/projects/**/*.jsonl` in read-only mode.
3. Hermit extracts usage metadata only.
4. Hermit stores local index state under `~/.hermit/session-index`.
5. Hermit pushes metadata through Task Bus reporting channel when enabled.

### Scenario 3: Team lead views usage

1. Team lead opens Team Usage dashboard.
2. Dashboard shows token usage by member, active days, session counts, harness mix, and tool call counts.
3. Team lead can filter by date range and harness.
4. Team lead cannot view prompts or assistant replies in v1.

### Scenario 4: Member offline

1. Member continues using Claude Code offline.
2. Hermit queues metadata reports locally.
3. When network/Task Bus connectivity returns, queued metadata is flushed.
4. Duplicate reports are ignored by `memberId + harness + sessionIdHash`.

## Functional Requirements

### FR-1: Task Bus Settings Integration

The existing Task Bus settings panel must explain telemetry behavior:

- "启用任务总线" also enables non-content usage telemetry.
- The UI must state that prompts, answers, files, and raw transcripts are not uploaded by default.
- The UI must show the current local index path and last collection time.

### FR-2: Local Session Index

Hermit must create a local index:

```text
~/.hermit/session-index/
  sessions.json
  stats.json
  state.json
  queue.jsonl
```

The index is derived from source sessions and can be rebuilt. It must not modify source session files.

### FR-3: Claude Code Parser

The v1 parser supports Claude Code:

| Harness | Location | Format | v1 |
|---------|----------|--------|----|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL | yes |
| Codex | `~/.codex/sessions/**/*.jsonl` | JSONL | later |
| OpenCode | TBD | TBD | later |

Parser output:

```typescript
interface LocalSessionUsage {
  harness: 'claude-code';
  sessionIdHash: string;
  sourcePathHash: string;
  projectHash?: string;
  projectLabel?: string;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  messageCount: number;
  toolCallCounts: Record<string, number>;
  models: string[];
}
```

### FR-4: Team Usage Report Payload

Metadata reports use a content-free payload:

```typescript
interface UsageReport {
  schemaVersion: 1;
  teamId: string;
  memberId: string;
  machineName: string;
  generatedAt: string;
  sessions: LocalSessionUsage[];
}
```

Reports must not include raw prompts, assistant messages, file paths, tool arguments, or raw JSONL.

### FR-5: Queue And Retry

When Task Bus or network transport is unavailable:

- reports are appended to `~/.hermit/session-index/queue.jsonl`
- retries use exponential backoff
- successful flush removes acknowledged entries
- duplicate entries are deduped by `sessionIdHash + updatedAt`

### FR-6: Team Usage Dashboard

Dashboard shows:

- token usage by member
- input/output/cache token split
- session count by member
- active days
- daily/weekly token trend
- harness distribution
- tool call counts by tool name
- top project labels or hashed project groups

Dashboard does not show transcript content in v1.

### FR-7: Doctor

Add a doctor check for session telemetry:

```text
openhermit doctor
```

Doctor should check:

- `~/.claude/projects` exists
- recent JSONL files are readable
- parser can parse at least one sample
- token extraction produces sane values
- local index is writable
- queue length
- last collection time
- Task Bus enabled/disabled
- reporting transport reachable/unreachable

### FR-8: MCP Local Tools

Hermit may expose local-only MCP tools for the owner:

- `session_recent`
- `session_search`
- `session_usage_stats`
- `session_get_transcript`

Only `session_usage_stats` feeds team reporting by default. Transcript tools are local-only unless a future explicit sharing mode is added.

## Non-Functional Requirements

### NFR-1: Privacy

- No transcript content is uploaded by default.
- No file content is uploaded.
- No shell command arguments are uploaded.
- Full project paths are not uploaded by default.
- Members should see a visible indicator when Task Bus telemetry is active.

### NFR-2: Reliability

- Local indexing must tolerate partially written JSONL files.
- Collection must be incremental.
- Corrupt session lines should be skipped with diagnostics, not fail the entire scan.
- Queue must survive restart.

### NFR-3: Performance

- Idle scanning should remain lightweight.
- Parser should use file mtime/size state to avoid full re-parse on every interval.
- Dashboard should load within 2 seconds for 50 members and 30 days of metadata.

### NFR-4: Extensibility

- New harnesses are added through parser adapters.
- Team reporting payload should remain metadata-only by default.

## Success Criteria

| ID | Criterion | Measure |
|----|-----------|---------|
| SC-1 | Enabling Task Bus starts local metadata indexing | `~/.hermit/session-index/stats.json` updates after local Claude activity |
| SC-2 | Team lead sees usage without transcript content | Dashboard shows tokens/sessions but no prompt text |
| SC-3 | Claude Code usage is parsed correctly | Sample JSONL produces expected token/message/tool counts |
| SC-4 | Offline queue works | Reports created offline flush when transport returns |
| SC-5 | Doctor explains health | `openhermit doctor` reports parser/index/queue status |

## Out Of Scope V1

- Uploading chat transcripts
- Reading file contents
- Uploading full file paths
- Uploading shell command arguments
- PostgreSQL setup UI
- Centralized enterprise data warehouse
- Codex/OpenCode parsers
- Remote transcript search

## Future Phase: Team Shared Insights

After local metadata reporting is stable, a future phase can add:

- optional transcript sharing
- per-member consent
- project label mapping
- organization-level storage backend
- retention policies
- billing exports

These features must remain opt-in and separate from default Task Bus telemetry.

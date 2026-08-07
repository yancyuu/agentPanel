---
name: cc-data-collection-logic
description: Use when inspecting, implementing, debugging, or reusing Claude Code data collection from ~/.claude/projects JSONL, ~/.claude/todos, session chunks, tool calls, subagents, token usage, costs, compaction, or context metrics
metadata:
  type: reference
  source: hermit
---

# CC Data Collection Logic

## Overview

Claude Code data collection is file-first: sessions are stored as JSONL under `~/.claude/projects`, todos are stored under `~/.claude/todos`, and most higher-level views are derived by streaming, normalizing, classifying, and chunking those files.

Core invariant: **preserve raw Claude Code semantics first, then derive UI/reporting models.** Do not drop `isMeta`, `isSidechain`, tool blocks, usage cache fields, compact summaries, or subagent identity while parsing.

## When to Use

Use this skill when you need to:

- read or index Claude Code session JSONL files;
- attach Claude Code todo files to sessions;
- classify real user messages vs tool results/meta messages;
- extract tool calls, tool results, model usage, cost, or token counts;
- build timelines/chunks from sessions;
- understand subagent/sidechain files and Task tool relationships;
- calculate context-window usage, cache tokens, or compaction phases;
- export or summarize Claude Code conversations;
- port Hermit-style Claude Code data collection into another app.

Do not use this skill for unrelated UI-only work that does not touch Claude Code session/todo data.

## Data Sources

### Session JSONL

Primary directory:

```text
~/.claude/projects/{encoded-project-path}/*.jsonl
```

Path encoding is Claude Code's filesystem encoding, not URL encoding:

```text
/Users/name/project -> -Users-name-project
```

A main session is usually:

```text
~/.claude/projects/{encoded-project-path}/{session_uuid}.jsonl
```

Subagent / sidechain sessions may appear in either current or legacy layout:

```text
~/.claude/projects/{encoded-project-path}/{session_uuid}/agent_{agent_uuid}.jsonl
~/.claude/projects/{encoded-project-path}/agent_{agent_uuid}.jsonl
```

### Todos

Todo data is stored separately by session id:

```text
~/.claude/todos/{sessionId}.json
```

Attach todos after you have extracted the `sessionId` from the session JSONL filename or message records.

## Canonical Files in Hermit

Use these Hermit files as reference implementations:

| Concern | Reference |
|---|---|
| Claude base/project/todo paths | `src/main/utils/pathDecoder.ts` |
| Raw Claude JSONL entry schema | `src/main/types/jsonl.ts` |
| Parsed/normalized message schema | `src/main/types/messages.ts` |
| Session/domain metrics schema | `src/main/types/domain.ts` |
| Chunk/timeline/process schema | `src/main/types/chunks.ts` |
| Session scanning + usage aggregation | `src/main/services/session-intelligence/SessionUsageParser.ts` |
| Conversation telemetry index | `src/main/services/session-intelligence/ConversationTelemetryService.ts` |
| Context-window metric normalization | `src/shared/utils/contextMetrics.ts` |
| Subagent phase/compaction breakdown | `src/renderer/utils/aiGroupHelpers.ts` |
| Conversation group transformation | `src/renderer/utils/groupTransformer.ts` |
| Visible context attribution | `src/renderer/utils/contextTracker.ts` |
| Export text extraction | `src/renderer/utils/sessionExporter.ts` |

Research docs worth reading:

- `docs/research/claude-coupling-analysis.md`
- `docs/research/context-usage-audit.md`
- `docs/research/claude-kanban-dataflow.md`

## Collection Pipeline

Follow this order. Each stage should preserve enough raw data for later stages.

### 1. Resolve Claude data roots

Use the same conceptual roots as Hermit:

```text
claudeBase = ~/.claude
projectsBase = ~/.claude/projects
todosBase = ~/.claude/todos
```

If the host app supports an override, resolve the override once and pass it through all path builders. Do not hardcode only `~/.claude` in reusable libraries.

### 2. Discover JSONL files

Recursively walk `projectsBase`.

Classify files:

- main session: normal `{session_uuid}.jsonl`;
- current subagent: nested `.../{session_uuid}/agent_{agent_uuid}.jsonl`;
- legacy subagent: root-level `agent_{agent_uuid}.jsonl`;
- ignore non-JSONL files.

Keep these fields at discovery time:

```ts
interface DiscoveredJsonlFile {
  filePath: string;
  projectId: string;
  sessionId: string;
  isSubagent: boolean;
  agentId?: string;
  layout: 'main' | 'nested-subagent' | 'legacy-subagent';
}
```

### 3. Stream parse JSONL

Read line by line. Do not load very large session files into memory as one string.

Recommended behavior:

- trim empty lines;
- `JSON.parse` each line independently;
- tolerate malformed lines by recording a warning and continuing;
- preserve line number for diagnostics;
- preserve unknown fields on raw entries if the host app may need them later.

### 4. Normalize messages

Normalize raw entries into a stable message model, but keep raw semantics:

- `uuid`
- `parentUuid`
- `sessionId`
- `timestamp`
- `cwd`
- `gitBranch`
- `role` / `type`
- `content`
- `isMeta`
- `isSidechain`
- `isCompactSummary`
- `agentId`
- `agentName`
- `usage`
- `requestId`
- `toolUseResult`
- `toolCalls`
- `toolResults`

Important classification rule:

- `isMeta: false` user entries are real user-visible messages.
- `isMeta: true` user entries are internal/tool/system-generated messages.
- A `user` message whose content is a `tool_result` block is a tool result, not a human-authored user message.

### 5. Extract text conservatively

Claude Code content can be:

- a string;
- an array of text blocks;
- an array of tool use blocks;
- an array of tool result blocks;
- mixed blocks.

Use separate extractors for:

- display text;
- searchable transcript text;
- tool-call summaries;
- tool-result summaries.

Do not show agent-only control blocks directly in user UI. In Hermit, agent-only blocks use helpers from `@shared/constants/agentBlocks`:

- `wrapAgentBlock(text)`
- `stripAgentBlocks(text)`
- `unwrapAgentBlock(block)`

### 6. Extract tool calls and results

Assistant messages may contain `tool_use` content blocks. User/meta messages may contain `tool_result` blocks.

Track at minimum:

```ts
interface ToolCallSummary {
  id: string;
  name: string;
  input?: unknown;
  startedAt?: string;
  result?: unknown;
  resultText?: string;
  errored?: boolean;
}
```

Do not double-count Task tool calls when a matching subagent process exists. Hermit rule:

- Task tool-use blocks are filtered when a subagent exists.
- Orphaned Task calls remain visible for debugging.

### 7. Attach todos

For each main session, attempt:

```text
~/.claude/todos/{sessionId}.json
```

If missing, treat as `undefined`, not an error. Todo schema can evolve; preserve raw todo JSON first, normalize later.

### 8. Compute usage metrics

For Anthropic/Claude Code usage, track these fields independently:

```text
input_tokens
output_tokens
cache_read_input_tokens
cache_creation_input_tokens
```

When estimating prompt/context input, include cache fields:

```text
anthropicPromptInput = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Common bug: using only `input_tokens` undercounts visible prompt/context consumption.

Aggregate per:

- message;
- session;
- model;
- tool;
- project;
- day/hour;
- compaction phase.

### 9. Detect compaction phases

A compact summary resets visible context accumulation.

Hermit-style phase model:

- phase starts at session beginning or immediately after compaction;
- compact summary closes the current phase;
- later context stats should be computed relative to the latest phase;
- preserve `compactionCount` and per-phase token totals.

Use `isCompactSummary` as the primary signal when normalized messages provide it.

### 10. Build timeline chunks

Map normalized messages into timeline chunks:

- `UserChunk`: a real user message with metrics.
- `AIChunk`: assistant responses, tool executions, and spawned subagents.
- `SystemChunk`: command output/system messages.
- `CompactChunk`: compaction summaries and structural context reset markers.

Each chunk should carry:

- timestamp;
- duration if computable;
- metrics: tokens, cost, tools;
- linked process/subagent ids when available.

### 11. Link subagents

Subagents can be inferred from:

- sidechain JSONL files;
- `isSidechain` entries;
- Task tool calls;
- `agentId` / `agentName` metadata;
- parent session path relationship.

Build a `Process`/subagent record with:

```ts
interface SubagentProcessSummary {
  id: string;
  name?: string;
  sessionId?: string;
  parentSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  status?: 'running' | 'completed' | 'failed' | 'unknown';
  metrics?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  };
}
```

## Quick Reference

| Question | Look at | Notes |
|---|---|---|
| Where are sessions? | `~/.claude/projects/{encoded-path}/*.jsonl` | encoded path uses leading `-` form |
| Where are todos? | `~/.claude/todos/{sessionId}.json` | optional per session |
| Is this a real user message? | `type/role`, `isMeta`, content blocks | `isMeta: true` is not human input |
| Is this a tool result? | user content contains `tool_result` | classify as tool/internal |
| Is this a compaction? | `isCompactSummary` | starts a new context phase |
| How to count Anthropic prompt input? | usage cache fields | include cache read + cache creation |
| How to avoid Task double count? | Task tool call + subagent presence | hide matched Task call, keep orphan |
| Where are subagents? | nested or legacy `agent_*.jsonl` | also use sidechain metadata |

## Common Mistakes

- Treating Claude Code project path encoding as URL encoding.
- Loading huge JSONL files all at once instead of streaming.
- Treating every `user` role as a real human message.
- Dropping `isMeta`, `isSidechain`, or `isCompactSummary` during normalization.
- Showing agent-only XML/control blocks to users.
- Counting only `input_tokens` and ignoring Anthropic cache token fields.
- Double-counting Task tool calls and spawned subagent sessions.
- Assuming todos are embedded in session JSONL; they are separate files.
- Assuming subagents only use one file layout; support nested and legacy layouts.
- Failing the whole scan on one malformed JSONL line.

## Minimal Implementation Checklist

When implementing a collector in a new project:

1. Resolve Claude base, projects, and todos paths.
2. Walk project directories and classify main vs subagent JSONL files.
3. Stream parse JSONL with bad-line warnings.
4. Normalize messages while preserving raw semantics.
5. Classify real user / assistant / tool result / system / compact entries.
6. Extract tool calls and tool results.
7. Attach todo JSON by session id.
8. Aggregate usage with cache token fields preserved.
9. Build compaction-aware context phases.
10. Link Task tool calls to subagent sessions.
11. Emit stable session, chunk, process, and metric objects.
12. Add tests with at least one real user message, one tool call/result pair, one compact summary, one todo file, and one subagent file.

## Suggested Test Fixtures

A good portable fixture set has:

```text
fixtures/claude/projects/-Users-test-project/main-session.jsonl
fixtures/claude/projects/-Users-test-project/main-session/agent_subagent.jsonl
fixtures/claude/todos/main-session.json
```

Test cases should assert:

- malformed lines do not abort the scan;
- real user messages exclude `isMeta: true` tool-result messages;
- `tool_use` and `tool_result` are linked by id;
- Anthropic prompt tokens include cache read and cache creation;
- compact summary increments compaction count and starts a new phase;
- subagent files are linked to the parent session;
- Task tool calls are not double-counted when a matching subagent exists;
- missing todo files are tolerated.

## Hermit Porting Notes

If you are copying logic out of Hermit:

- Start from `SessionUsageParser.ts` for scanning and aggregate metrics.
- Add `ConversationTelemetryService.ts` if you need searchable conversation snippets and cached indexing.
- Add `contextMetrics.ts`, `aiGroupHelpers.ts`, and `contextTracker.ts` if you need context-window/compaction attribution.
- Add `chunks.ts` and `groupTransformer.ts` if you need a UI timeline.
- Keep raw JSONL and normalized message types separate. This makes future Claude Code schema changes easier to absorb.

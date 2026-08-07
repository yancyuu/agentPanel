# Feature Specification: openHermit CLI for Agents and Operators

## Overview

openHermit should expose a first-class CLI surface for the same local workspace that the Web UI presents to humans. The Web UI remains the human control plane for teams, tasks, messages, channels, reviews, and runtime observation. The CLI becomes the stable entry point for agents and operators to inspect local state, run diagnostics, and later report local usage facts without implicitly starting the browser workspace.

> Web UI for humans. CLI for agents and operators.

## Product Boundary

openHermit is the control-plane orchestration layer for local AI runtime workspaces. It coordinates teams, tasks, messages, channels, dispatch state, usage facts, and audit trails.

It does **not** orchestrate agent thinking, planning, tool use, or retry logic. Those stay inside the selected AI runtime such as Claude Code, Codex, Gemini, Cursor, OpenCode, or a bridge-backed runtime.

The CLI is explicitly open to agents and operators:

```text
Agent/operator -> openHermit CLI -> openHermit control-plane state/actions
```

But the CLI must not become a hidden agent brain:

```text
Not: CLI -> LLM -> CLI -> LLM
```

In practice, agents may use the CLI like `git`, `gh`, or `kubectl`: query facts, write explicit state, and trigger clear control-plane actions. CLI commands must not secretly ask an LLM to decide what to do.

## Problem Statement

openHermit already stores local team/task/message/runtime state under `~/.hermit/` and exposes it through the `/teams` Web UI. Agents and operators need a scriptable way to inspect the same state from automation loops, cron jobs, CI-like local checks, and shell sessions. A usage-only CLI would feel abrupt because an agent first needs to know where openHermit is, whether the local runtime is healthy, and what teams/tasks exist before it can reliably report facts.

Without this feature:

- agents must scrape UI/API state or ask humans to inspect the Web UI;
- usage reporting has no clear local verification path;
- operational commands remain mixed with the Web startup command;
- future CLI writes would lack a read-only foundation and consistent output contract.

## User Scenarios & Testing

### Primary Scenario: Agent inspects local workspace

1. An agent runs `hermit status --json`.
2. The command returns version, `HERMIT_HOME`, daemon/server status, and known local paths.
3. The agent runs `hermit teams list --json`.
4. The command returns local teams from `~/.hermit/teams` without starting the Web UI.
5. The agent runs `hermit tasks list --team <team> --json`.
6. The command returns active tasks for that team using the same status vocabulary as the UI/API.

### Alternative Scenario: Operator runs diagnostics

1. An operator runs `hermit doctor`.
2. The command checks local state paths, daemon pidfile, bridge config presence, and Claude Code session path presence.
3. The command prints actionable read-only diagnostics.
4. With `--json`, the same facts are machine-readable.

### Alternative Scenario: Usage reporting builds on CLI foundation

1. An operator runs `hermit usage today` to verify local Claude Code usage totals.
2. The command scans local metadata only and does not upload.
3. Later `hermit usage report` can reuse the same no-Web CLI dispatch, JSON/text output, privacy rules, and diagnostics style.

### Edge Cases

- `~/.hermit/` does not exist: commands still succeed with empty lists and clear diagnostics.
- `~/.hermit/teams` does not exist: `teams list` returns an empty list, not an error.
- A team manifest is malformed: list commands skip it and include a warning in JSON/text output.
- A task board is missing: `tasks list` returns an empty task list for the resolved team.
- A team argument is a `bindProject` alias rather than storage slug: `tasks list --team` resolves it by scanning manifests.
- Commands with `--json` must output valid JSON only, with no prefixed log lines.

## Functional Requirements

### FR-1: No-Web CLI Dispatch

The CLI must intercept read-only workspace commands before dependency checks, bridge startup, Web server startup, and daemon startup. These commands must not start Fastify, Vite, hermit-bridge, or create starter runtime config.

### FR-2: Consistent Output Modes

Every new CLI command must support default human-readable text and `--json`. JSON mode must emit a stable object with `ok`, `command`, and command-specific data fields.

### FR-3: Status Command

`hermit status` must continue to show daemon/service status. `hermit status --json` must return structured status including version, port, `hermitHome`, pidfile state, running pids if known, and URL.

### FR-4: Doctor Command

`hermit doctor` must run read-only local checks for:

- `HERMIT_HOME` path;
- teams directory presence;
- daemon pidfile presence and pid liveness;
- openHermit HTTP status on the selected port;
- hermit-bridge config file presence;
- Claude Code projects directory presence.

It must not modify, delete, migrate, or create config files.

### FR-5: Teams List Command

`hermit teams list` must read `~/.hermit/teams/*/team.json`, skip reserved/system teams that the Web API hides, and output useful fields: slug, display name, bind project, harness, work directory, pending delete/deleted state, and updated/created timestamps when available.

### FR-6: Tasks List Command

`hermit tasks list --team <slug-or-bindProject>` must resolve storage slug or bindProject alias, read `tasks/board.json`, hide soft-deleted tasks, and map persisted statuses to CLI/API statuses:

- `todo` -> `pending`
- `doing` -> `in_progress`
- `done` -> `completed`

### FR-7: Usage Commands Are Follow-Up, Not Sole Phase One

The CLI architecture must leave room for `hermit usage today/status/report/start`, but the first phase is considered complete only when status, doctor, teams list, and tasks list exist. Usage reporting is a second vertical slice built on the same output and no-Web dispatch conventions.

## Non-Functional Requirements

### NFR-1: Local-First And Read-Only By Default

Phase one commands must only read local state. They must not create teams, tasks, messages, config, queues, uploads, or runtime processes.

### NFR-2: Privacy

Workspace commands must not print secrets or bridge tokens. Future usage commands must use metadata-only allowlists and must not expose prompts, assistant responses, raw JSONL, full paths in upload payloads, shell arguments, screenshots, or prompt-derived titles.

### NFR-3: Agent-Friendly Stability

JSON field names and exit behavior must be stable enough for scripts. Empty local state should be a successful result where possible.

### NFR-4: Minimal Technical Debt

The first implementation should reuse existing file formats and avoid adding a parallel database or a new project. Any small filesystem reader duplicated in the CLI must be limited to no-Web read-only projection and documented by tests.

### NFR-5: Anti-Nesting

The CLI is a fact/action surface for the control plane, not an agent runtime. It may expose commands that agents call, but it must not implement hidden LLM decision loops, duplicate runtime planning/todo/retry logic, or create CLI -> LLM -> CLI recursion.

## Success Criteria

| ID | Criterion | Measure |
| --- | --- | --- |
| SC-1 | CLI foundation exists | `node bin/hermit.mjs status --json`, `doctor --json`, `teams list --json`, and `tasks list --team <team> --json` run without starting Web UI |
| SC-2 | Agent-readable output | JSON commands emit parseable JSON only |
| SC-3 | Web/API vocabulary alignment | task statuses match `pending`, `in_progress`, `completed` |
| SC-4 | Read-only safety | Commands do not create or mutate `~/.hermit` state during normal reads |
| SC-5 | Usage path is not isolated | usage spec and tasks reference the same CLI output/no-Web conventions |

## Assumptions

- `HERMIT_HOME` defaults to `~/.hermit/` and may be overridden by environment variable.
- Team manifests live under `~/.hermit/teams/<slug>/team.json`.
- Task boards live under `~/.hermit/teams/<slug>/tasks/board.json`.
- The npm package exposes equivalent binaries: `hermit`, `openhermit`, and `open-hermit`.

## Dependencies

- Existing `bin/hermit.mjs` entry point.
- Existing local team/task file formats used by `TeamWorkspaceService`.
- Existing Claude Code session parser for later usage commands.

## Out of Scope

- Creating teams or tasks from CLI in phase one.
- Sending messages from CLI in phase one.
- Starting/stopping hermit-bridge beyond existing `openhermit` startup behavior.
- Repositioning `hermit-bridge`.
- Using hooks as the primary usage reporting path.
- Uploading transcripts, prompts, assistant responses, raw JSONL, file contents, or shell/tool arguments.

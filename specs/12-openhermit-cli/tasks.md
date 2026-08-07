# Tasks: openHermit CLI for Agents and Operators

## Phase 1: Spec Kit And Scope

### Task 1.1: Create Formal Spec Kit
- [x] Create `specs/12-openhermit-cli/`
- [x] Define CLI positioning: Web UI for humans, CLI for agents/operators
- [x] Make phase one broader than usage-only
- [x] Document read-only safety and privacy boundaries

### Task 1.2: Sync Product Spec
- [x] Update `docs/specs/openhermit-cli.md` so it no longer says phase one is usage-only
- [ ] Keep README positioning recommendations aligned with the new CLI framing

## Phase 2: CLI Foundation

### Task 2.1: No-Web Command Dispatch
- [x] Intercept CLI foundation commands before dependency checks
- [x] Ensure commands do not start Web UI
- [x] Ensure commands do not start hermit-bridge
- [x] Preserve existing default `openhermit` startup behavior

### Task 2.2: Output Helpers
- [x] Add consistent text output
- [x] Add `--json` output
- [x] Ensure JSON mode emits parseable JSON only
- [x] Include warnings in structured JSON where relevant

## Phase 3: Read-Only Commands

### Task 3.1: Structured Status
- [x] Extend `status` with `--json`
- [x] Include version, port, URL, `HERMIT_HOME`, pidfile path, pid state, and fallback pids
- [x] Preserve existing text status behavior

### Task 3.2: Doctor
- [x] Add `hermit doctor`
- [x] Add `hermit doctor --json`
- [x] Check local paths and runtime/server reachability read-only
- [x] Avoid creating or migrating runtime config
- [x] Avoid printing secrets

### Task 3.3: Teams List
- [x] Add `hermit teams list`
- [x] Add `hermit teams list --json`
- [x] Read `~/.hermit/teams/*/team.json`
- [x] Hide reserved/system teams consistently with the Web API
- [x] Include warnings for malformed manifests

### Task 3.4: Tasks List
- [x] Add `hermit tasks list --team <team>`
- [x] Add `hermit tasks list --team <team> --json`
- [x] Resolve direct storage slug and `bindProject` alias
- [x] Hide soft-deleted tasks
- [x] Map statuses to `pending`, `in_progress`, `completed`

## Phase 4: Tests And Verification

### Task 4.1: CLI Fixture Tests
- [x] Add focused tests for teams/tasks projection if test harness supports CLI invocation
- [x] Cover empty `HERMIT_HOME`
- [x] Cover malformed team manifest warning
- [x] Cover bindProject alias resolution
- [x] Cover status mapping

### Task 4.2: Manual CLI Smoke
- [x] Run `node bin/hermit.mjs status --json`
- [x] Run `node bin/hermit.mjs doctor --json`
- [x] Run `node bin/hermit.mjs teams list --json`
- [x] Run `node bin/hermit.mjs tasks list --team <team> --json` with a fixture
- [x] Run `pnpm typecheck 2>&1 | tail -20`

## Phase 5: Local Usage Follow-Up

### Task 5.1: Usage Today/Status
- [x] Add `hermit usage today`
- [x] Add `hermit usage status`
- [x] Reuse existing Claude Code session scanner
- [x] Do not upload in read-only commands

### Task 5.2: Metadata-Only Usage Reporting
- [ ] Add privacy allowlist payload mapping
- [x] Add local worker state cache
- [ ] Add neutral usage upload gate, separate from IM usage gate
- [x] Add `hermit usage report`
- [x] Add `hermit usage start`
- [x] Add lightweight telemetry worker process that does not start Web/bridge
- [x] Add `hermit usage stop`
- [x] Add macOS launchd autostart management for usage worker

## Out Of Scope Phase 1

- [ ] `tasks create`
- [ ] `messages send`
- [ ] config mutation commands
- [ ] runtime restart commands beyond existing service startup/stop behavior
- [ ] transcript upload
- [ ] hook-based primary reporting

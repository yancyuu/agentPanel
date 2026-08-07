# Requirements Checklist: openHermit CLI

## Scope Quality

- [x] Feature has a clear product frame: Web UI for humans, CLI for agents/operators
- [x] Phase one is not usage-only
- [x] Phase one starts with read-only commands
- [x] Usage reporting is documented as a follow-up slice
- [x] Out-of-scope write commands are explicit

## Requirement Testability

- [x] `status --json` behavior is testable
- [x] `doctor --json` behavior is testable
- [x] `teams list --json` behavior is testable
- [x] `tasks list --team --json` behavior is testable
- [x] Task status mapping is explicit
- [x] Missing local state behavior is explicit

## Safety And Privacy

- [x] Phase-one commands are read-only
- [x] Commands must not start Web UI or hermit-bridge
- [x] Doctor must not print secrets
- [x] Future usage upload must be metadata-only
- [x] IM usage and local Claude Code usage remain separate

## Implementation Constraints

- [x] Reuses existing `~/.hermit` storage shape
- [x] Avoids a new database in phase one
- [x] Avoids a new standalone project
- [x] Keeps TypeScript/path-alias constraints visible for CLI implementation

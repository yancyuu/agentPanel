<!-- markdownlint-disable MD013 -->

# Research And Architecture Decisions

## Decision 1: Split `server.ts` Before Any Product Change

**Decision:** Phase 0 is a hard gate. First extract `ServerContext`, Fastify app factory and domain route plugins while preserving behavior.

**Reason:** `src/main/server.ts` currently combines shared state, service composition, event listeners, routes, startup and shutdown. Starting Electron or private-activity changes before untangling this file would mix structural and behavioral risk.

**Rejected alternative:** Wrap the existing monolithic server immediately and refactor later. This gives a quick demo but makes lifecycle ownership, CLI separation and route extraction harder to verify.

## Decision 2: Electron For The First Desktop Release

**Decision:** Use Electron for Windows/macOS first release.

**Reason:** The current backend and runtime integration are Node/Fastify based. Electron can own the server factory and Node child processes without introducing a separately compiled Node sidecar.

**Rejected alternative:** Tauri with Node sidecar. It may reduce shell size but adds sidecar lifecycle, signing and cross-platform packaging complexity before the product boundary is stable.

## Decision 3: Reuse The Current UI Style

**Decision:** Keep the existing visual language and component stack. Do not copy Multica's visual design.

**Reason:** The first release should validate the product split and private task loop, not undertake a design-system rewrite.

**Borrowed concept only:** task-centric activity threads, a private inbox and agents as future assignable participants.

## Decision 4: Private Activity, Not Management Dashboard

**Decision:** The primary model is a private activity thread. A task is the root activity; user comments create the next execution round.

**Reason:** This matches an individual user's recurring interaction with an agent better than kanban-first administration while still allowing existing settings and management pages to remain secondary screens.

## Decision 5: Multi-Agent Ready, Not Multi-Agent Complete

**Decision:** Contracts and persisted rounds include `agentId`; first release defaults to one agent and does not implement parallel fan-out.

**Reason:** This avoids a future migration while keeping the first release bounded.

## Decision 6: Preserve HTTP Transport In The Desktop App

**Decision:** Electron starts the extracted Fastify app on loopback and the renderer continues to use the existing HTTP API adapter.

**Reason:** Rewriting the transport to Electron IPC adds little first-release value and would increase renderer regressions. Electron-specific capabilities should use a minimal preload bridge only when HTTP is unsuitable.

## Decision 7: CLI Must Not Depend On The Desktop App

**Decision:** The slim CLI uses shared application services or CLI adapters directly for message bus, user/auth and token pool operations.

**Reason:** Requiring a GUI process for CLI commands contradicts the intended product split.

**Rejected alternative:** Keep a hidden workbench server in the CLI. This would leave the original coupling in place under a different name.

## Decision 8: Remove Usage Telemetry, Preserve Lark Credential Reporting

**Decision:** Usage telemetry commands, routes and worker are removed from both products. Lark personal credential reporting remains as a separately tested authorization concern.

**Reason:** The user explicitly removed usage reporting while retaining Feishu authorization reporting. The two flows must not share a lifecycle gate.

## Decision 9: Lark Authorization Identity Is Fixed

**Decision:** Feishu digital-worker creation uses the real lark-cli personal profile with `as user --domain all`.

**Reason:** Bot/app tokens and AgentBus login tokens have different identity and permission semantics and cannot substitute for personal authorization.

## Decision 10: Unsigned Cross-Platform MVP First

**Decision:** The first milestone produces Windows x64 and macOS arm64/x64 installers without blocking on signing, notarization or automatic updates.

**Reason:** Packaging and product validation can complete before certificate procurement. Signing and updater work remain a later release-hardening milestone.

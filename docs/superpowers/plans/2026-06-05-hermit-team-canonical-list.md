# Hermit Team Canonical List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermit local team manifests the canonical source for digital employee/team listing, with cc-connect and Feishu treated as optional runtime/integration overlays.

**Architecture:** `/api/teams` must list Hermit-managed teams from `TeamProvisioningService.listTeams()` and overlay cc-connect project status by each manifest's `bindProject`; it must not synthesize teams from raw cc-connect projects such as `feishu:*`, `my-project`, or `system-manager`. Team creation remains local/Hermit-first and Feishu remains an optional platform binding surfaced later from team detail/integrations.

**Tech Stack:** Fastify server, TypeScript, TeamProvisioningService/TeamWorkspaceService, Vitest, pnpm.

---

## File Structure

- Modify: `src/main/server.ts`
  - Responsibility: `/api/teams` aggregation logic; use local Hermit team manifests as canonical data and cc-connect only for overlay status/sessions/platform metadata.
- Test: `test/main/server.teamList.test.ts`
  - Responsibility: regression coverage for team list filtering and overlay behavior using mocked local teams/projects.
- Modify: existing focused tests only if their expectations assumed raw cc-connect projects become teams.

---

### Task 1: Extract team summary building around local manifests

**Files:**
- Modify: `src/main/server.ts`

- [ ] **Step 1: Identify current `/api/teams` behavior**

Find the `app.get('/api/teams'...)` handler. Current behavior builds summaries from `cc.listProjects()` first and appends local-only teams later. This is the bug because raw cc-connect projects such as `feishu:*` become digital employee cards.

- [ ] **Step 2: Replace canonical iteration**

Change `/api/teams` so it:

1. Fetches `projects = await cc.listProjects().catch(() => [])` and `localTeams = await svc.listTeams().catch(() => [])`.
2. Builds `projectByName = new Map(projects.map((project) => [project.name, project]))`.
3. Iterates only over `localTeams`.
4. Skips reserved manifests:
   - `default`
   - `my-project`
   - `system-manager`
   - any `team.slug` or `team.bindProject` starting with `feishu:`
   - `team.pendingDelete === true`
5. For each local manifest, overlays cc-connect project status using `const project = projectByName.get(team.bindProject || team.slug)`.
6. Computes `isAlive`, `sessionsCount`, `heartbeatEnabled`, `harness`, `workDir`, and members from manifest first, project second.

The resulting summary must use:

```ts
teamName: team.slug,
displayName: team.displayName || team.slug,
bindProject: team.bindProject || team.slug,
workDir: project?.work_dir ?? team.workDir,
projectPath: project?.work_dir ?? team.workDir,
harness: project?.agent_type ?? team.harness,
```

- [ ] **Step 3: Keep provisioning snapshots intact**

Do not remove renderer synthetic provisioning snapshots. `/api/teams` should only return persisted Hermit teams plus overlay status.

---

### Task 2: Add regression tests for team listing model

**Files:**
- Create: `test/main/server.teamList.test.ts` if route-level Fastify tests are practical in this repo.
- Otherwise add focused unit tests around a pure helper extracted from `src/main/server.ts`.

- [ ] **Step 1: Extract a pure helper if needed**

If testing `server.ts` directly is too heavy, create `src/main/utils/teamSummaryBuilder.ts` with:

```ts
export function buildHermitTeamSummaries(localTeams, projects): TeamSummary[]
```

The helper should implement the canonical local-team-first logic from Task 1. `/api/teams` should call it.

- [ ] **Step 2: Write tests**

Test cases:

1. raw cc-connect `feishu:*` project is not returned without a local manifest.
2. raw cc-connect `hermit` project is not returned without a local manifest.
3. local manifest `jianjing-product` is returned and overlaid with cc project status from `bindProject`.
4. reserved `system-manager` and `my-project` are not returned.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm test test/main/utils/teamSummaryBuilder.test.ts 2>&1 | tail -80
```

Expected: tests pass.

---

### Task 3: Verify existing flows

**Files:**
- No source changes unless verification fails.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm typecheck 2>&1 | tail -40
```

Expected: TypeScript passes.

- [ ] **Step 2: Focused tests**

Run:

```bash
pnpm test test/main/utils/teamSummaryBuilder.test.ts test/renderer/store/teamSlice.test.ts test/renderer/components/system-manager/SystemManagerView.test.tsx test/renderer/api/httpClient.terminal.test.ts 2>&1 | tail -100
```

Expected: all pass.

- [ ] **Step 3: Runtime smoke**

With dev server on non-5680 port, run:

```bash
curl -s http://127.0.0.1:5681/api/teams | python3 -c 'import json,sys; print([t["teamName"] for t in json.load(sys.stdin)])'
```

Expected: no `feishu:*`, no `my-project`, no `system-manager`. Only Hermit-managed local team manifests should appear.

---

## Self-Review

- Spec coverage: The plan makes local Hermit teams canonical, uses cc-connect only as overlay, filters Feishu/raw project noise, and preserves control console separation.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: The plan introduces only one optional helper, `buildHermitTeamSummaries`, and uses existing `TeamSummary`, `TeamManifest`, and cc-connect project shapes.

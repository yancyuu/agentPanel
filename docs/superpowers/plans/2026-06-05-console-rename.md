# Console Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the user-visible “系统管家” entry to “控制台” while keeping internal `system-manager` identifiers stable.

**Architecture:** Keep the existing `SYSTEM_MANAGER_TEAM_NAME`, `SystemManagerView`, and `/api/system-manager/ensure` route unchanged. Update only display strings, descriptions, user-facing error messages, and test expectations so existing storage, routing, and manifests remain compatible.

**Tech Stack:** Electron, React, TypeScript, Zustand, Vitest, pnpm.

---

## File Structure

- Modify: `src/shared/types/team.ts`
  - Responsibility: shared constants and `SystemManagerSummary` display type.
- Modify: `src/main/server.ts`
  - Responsibility: backend-created display name, description, comments, and delete-protection error message.
- Modify: `src/renderer/components/system-manager/SystemManagerView.tsx`
  - Responsibility: visible loading/error text on the console page.
- Modify: `src/renderer/components/team/TeamListView.tsx`
  - Responsibility: visible button label that opens the console.
- Modify: `test/renderer/store/teamSlice.test.ts`
  - Responsibility: expected opened tab label.
- Modify: `test/renderer/components/system-manager/SystemManagerView.test.tsx`
  - Responsibility: mocked summary display name and text assertions.
- Modify: `test/main/utils/teamProjectResolution.test.ts`
  - Responsibility: fixture display name only.

---

### Task 1: Update user-visible copy to 控制台

**Files:**
- Modify: `src/shared/types/team.ts`
- Modify: `src/main/server.ts`
- Modify: `src/renderer/components/system-manager/SystemManagerView.tsx`
- Modify: `src/renderer/components/team/TeamListView.tsx`

- [ ] **Step 1: Change shared display constant**

In `src/shared/types/team.ts`, set:

```ts
export const SYSTEM_MANAGER_DISPLAY_NAME = '控制台';
```

Keep this unchanged:

```ts
export const SYSTEM_MANAGER_TEAM_NAME = 'system-manager';
export const SYSTEM_MANAGER_BIND_PROJECT = 'my-project';
```

- [ ] **Step 2: Change backend visible description and error text**

In `src/main/server.ts`, change the description to:

```ts
const SYSTEM_MANAGER_DESCRIPTION =
  '项目级 Claude Code 控制台，负责插件、MCP、Env、数字员工和统计数据的托管管理。';
```

Change the ensure route comment to:

```ts
// POST /api/system-manager/ensure → 确保项目级控制台存在
```

Change the reserved-team deletion error to:

```ts
return reply.code(403).send({ error: '控制台不可删除' });
```

- [ ] **Step 3: Change renderer visible page text**

In `src/renderer/components/system-manager/SystemManagerView.tsx`, change the loading text to:

```tsx
<Loader2 size={14} className="animate-spin" /> 初始化控制台...
```

- [ ] **Step 4: Change team list button text**

In `src/renderer/components/team/TeamListView.tsx`, change the open button label to:

```tsx
控制台
```

---

### Task 2: Update tests and focused verification

**Files:**
- Modify: `test/renderer/store/teamSlice.test.ts`
- Modify: `test/renderer/components/system-manager/SystemManagerView.test.tsx`
- Modify: `test/main/utils/teamProjectResolution.test.ts`

- [ ] **Step 1: Update test fixtures**

Replace fixture display names and descriptions:

```ts
displayName: '控制台'
description: '项目级 Claude Code 控制台'
```

Update tab label expectation:

```ts
label: '控制台'
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm test test/renderer/components/system-manager/SystemManagerView.test.tsx test/renderer/store/teamSlice.test.ts test/main/utils/teamProjectResolution.test.ts 2>&1 | tail -80
```

Expected: all listed test files pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: `tsc --noEmit` exits 0.

---

### Task 3: Launch app on a non-5680 port

**Files:**
- No source changes unless launch uncovers a build/runtime issue.

- [ ] **Step 1: Check project launch command**

Use the repo command:

```bash
pnpm dev -- --port 5681
```

If 5681 is occupied, use the next free port such as 5682.

- [ ] **Step 2: Launch in background**

Run:

```bash
pnpm dev -- --port 5681
```

Expected: the dev server starts without using port 5680.

- [ ] **Step 3: Report the page URL**

Report the localhost URL printed by the dev server, or state the final port chosen if the command uses a different one.

---

## Self-Review

- Spec coverage: The plan renames only user-visible copy from “系统管家” to “控制台”, keeps internal `system-manager` identifiers unchanged, updates tests, verifies with focused tests/typecheck, and launches on a non-5680 port.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: `SYSTEM_MANAGER_DISPLAY_NAME`, `SYSTEM_MANAGER_TEAM_NAME`, and `SYSTEM_MANAGER_BIND_PROJECT` remain the shared constants used by existing code.

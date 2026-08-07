# System Manager Claude Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the system-manager fake terminal and hard-coded quick prompts with the existing Claude Code team/session messaging surface so Claude slash commands are handled by the runtime.

**Architecture:** Keep `system-manager` as the local team slug bound to cc-connect project `my-project`. `SystemManagerView` becomes a thin wrapper that ensures the manager exists, fetches the same team snapshot/session/message data used by `TeamDetailView`, and renders the existing `CcSessionsSection` plus `MessagesPanel` inline. No custom quick prompts or fake terminal history remain.

**Tech Stack:** Electron/React 19, TypeScript, Zustand team store, existing `api.teams`, `MessagesPanel`, `CcSessionsSection`, Vitest.

---

## File Structure

- Modify: `src/renderer/components/system-manager/SystemManagerView.tsx`
  - Responsibility: thin system-manager page that ensures the system manager and delegates interaction to existing team messaging/session components.
- Modify: `src/renderer/components/team/messages/MessagesPanel.tsx` only if required by TypeScript props, but prefer no changes.
  - Responsibility: keep existing shared message UI unchanged.
- Test: `test/renderer/components/system-manager/SystemManagerView.test.tsx`
  - Responsibility: prove the page no longer exposes hard-coded quick prompts and passes messages through existing runtime/team APIs.

---

### Task 1: Add regression test for removing hard-coded quick prompts

**Files:**
- Create: `test/renderer/components/system-manager/SystemManagerView.test.tsx`
- Modify: none

- [ ] **Step 1: Write the failing test**

Create `test/renderer/components/system-manager/SystemManagerView.test.tsx`:

```tsx
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../../src/renderer/api';
import { SystemManagerView } from '../../../../src/renderer/components/system-manager/SystemManagerView';
import { useStore } from '../../../../src/renderer/store';
import { SYSTEM_MANAGER_TEAM_NAME } from '../../../../src/shared/types/team';

vi.mock('../../../../src/renderer/api', () => ({
  api: {
    teams: {
      ensureSystemManager: vi.fn(),
      getTeamData: vi.fn(),
      getSessions: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/renderer/components/team/messages/MessagesPanel', () => ({
  MessagesPanel: (props: { teamName: string; isTeamAlive?: boolean }) => (
    <div data-testid="messages-panel" data-team-name={props.teamName} data-alive={String(props.isTeamAlive)}>
      Shared MessagesPanel
    </div>
  ),
}));

vi.mock('../../../../src/renderer/components/team/CcSessionsSection', () => ({
  CcSessionsSection: (props: { teamName: string; sessions: unknown[] }) => (
    <div data-testid="sessions-section" data-team-name={props.teamName} data-count={props.sessions.length}>
      Shared CcSessionsSection
    </div>
  ),
}));

const summary = {
  teamName: SYSTEM_MANAGER_TEAM_NAME,
  displayName: '系统管家',
  bindProject: 'my-project',
  workDir: '/repo',
  projectPath: '/repo',
  description: '项目级 Claude Code 系统管家',
  localStatus: 'ready',
  ccConnectProjectStatus: 'bound',
  feishuStatus: 'unbound',
} as const;

const teamData = {
  teamName: SYSTEM_MANAGER_TEAM_NAME,
  config: {
    name: '系统管家',
    members: [{ name: '系统管家', role: 'lead' }],
  },
  tasks: [],
  members: [{ name: '系统管家', role: 'lead', color: 'slate' }],
  kanbanState: { teamName: SYSTEM_MANAGER_TEAM_NAME, reviewers: [], tasks: {} },
  processes: [],
  isAlive: true,
  harness: 'claudecode',
  bindProject: 'my-project',
  collaboration: false,
  description: '项目级 Claude Code 系统管家',
  workDir: '/repo',
  providerRefs: [],
  globalProviders: [],
  settings: {},
  heartbeat: null,
  activeSessions: [],
};

function renderSystemManager() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(<SystemManagerView />);
  });

  return { host, root };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  useStore.setState({
    teamMessages: {},
    messagesPagination: {},
  });
});

describe('SystemManagerView', () => {
  it('renders shared Claude Code team messaging instead of hard-coded quick prompts', async () => {
    vi.mocked(api.teams.ensureSystemManager).mockResolvedValue(summary);
    vi.mocked(api.teams.getTeamData).mockResolvedValue(teamData as never);
    vi.mocked(api.teams.getSessions).mockResolvedValue([]);

    const { host, root } = renderSystemManager();
    await flushPromises();

    expect(api.teams.ensureSystemManager).toHaveBeenCalledTimes(1);
    expect(api.teams.getTeamData).toHaveBeenCalledWith(SYSTEM_MANAGER_TEAM_NAME);
    expect(api.teams.getSessions).toHaveBeenCalledWith(SYSTEM_MANAGER_TEAM_NAME);
    expect(host.querySelector('[data-testid="messages-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sessions-section"]')).not.toBeNull();
    expect(host.textContent).not.toContain('快捷目标');
    expect(host.textContent).not.toContain('帮我安装 playwright MCP');
    expect(host.textContent).not.toContain('SYSTEM_MANAGER_REQUEST');

    await act(async () => {
      root.unmount();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test test/renderer/components/system-manager/SystemManagerView.test.tsx 2>&1 | tail -80
```

Expected: FAIL because `SystemManagerView` still renders `快捷目标` / quick prompts and does not render the mocked `MessagesPanel` or `CcSessionsSection`.

---

### Task 2: Replace fake terminal with shared session/message panels

**Files:**
- Modify: `src/renderer/components/system-manager/SystemManagerView.tsx`
- Test: `test/renderer/components/system-manager/SystemManagerView.test.tsx`

- [ ] **Step 1: Implement minimal shared-panel version**

Replace the custom `Textarea`, `QUICK_PROMPTS`, `history`, and `submit()` logic in `src/renderer/components/system-manager/SystemManagerView.tsx` with a wrapper that loads the existing team data and sessions and renders shared components.

The resulting file should follow this shape:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { CcSessionsSection } from '@renderer/components/team/CcSessionsSection';
import { MessagesPanel } from '@renderer/components/team/messages/MessagesPanel';
import { useStore } from '@renderer/store';
import {
  SYSTEM_MANAGER_DISPLAY_NAME,
  SYSTEM_MANAGER_TEAM_NAME,
  type SystemManagerSummary,
} from '@shared/types/team';
import { Bot, Loader2, MessageSquare, Terminal } from 'lucide-react';

import type { CcSession, ResolvedTeamMember, TeamTaskWithKanban, TeamViewSnapshot } from '@shared/types';

interface SystemManagerViewProps {
  isPaneFocused?: boolean;
}

function toResolvedMembers(data: TeamViewSnapshot | null): ResolvedTeamMember[] {
  return (data?.members ?? []).map((member) => ({
    ...member,
    name: member.name,
    role: member.role ?? 'lead',
    color: member.color ?? 'slate',
  })) as ResolvedTeamMember[];
}

function toTeamTasks(data: TeamViewSnapshot | null): TeamTaskWithKanban[] {
  return (data?.tasks ?? []) as TeamTaskWithKanban[];
}

export const SystemManagerView = ({
  isPaneFocused: _isPaneFocused = false,
}: SystemManagerViewProps): React.JSX.Element => {
  const [manager, setManager] = useState<SystemManagerSummary | null>(null);
  const [teamData, setTeamData] = useState<TeamViewSnapshot | null>(null);
  const [sessions, setSessions] = useState<CcSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pendingRepliesByMember, setPendingRepliesByMember] = useState<Record<string, number>>({});

  const loadSystemManager = useCallback(async () => {
    setLoading(true);
    setSessionsLoading(true);
    setError(null);
    setSessionsError(null);
    try {
      const summary = await api.teams.ensureSystemManager();
      setManager(summary);
      const data = await api.teams.getTeamData(SYSTEM_MANAGER_TEAM_NAME);
      setTeamData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }

    try {
      const nextSessions = await api.teams.getSessions(SYSTEM_MANAGER_TEAM_NAME);
      setSessions(nextSessions);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err));
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSystemManager();
  }, [loadSystemManager]);

  const statusLine = useMemo(() => {
    if (!manager) return 'local: starting · cc-connect: unknown · feishu: unknown';
    return `local: ${manager.localStatus} · cc-connect: ${manager.bindProject}/${manager.ccConnectProjectStatus} · feishu: ${manager.feishuStatus}`;
  }, [manager]);

  const members = useMemo(() => toResolvedMembers(teamData), [teamData]);
  const tasks = useMemo(() => toTeamTasks(teamData), [teamData]);
  const teamMessages = useStore((state) => state.teamMessages[SYSTEM_MANAGER_TEAM_NAME] ?? []);
  const currentLeadSessionId = sessions.find((session) => session.live)?.id ?? sessions[0]?.id;

  return (
    <div className="flex size-full flex-col bg-[#08090c] text-slate-100">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
            <Bot size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">{SYSTEM_MANAGER_DISPLAY_NAME}</h2>
              <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-300">
                Claude Code runtime
              </span>
            </div>
            <p className="font-mono text-[11px] text-slate-400">{statusLine}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadSystemManager()}
          className="rounded border border-white/10 px-3 py-1 text-xs text-slate-300 hover:border-cyan-400/40 hover:text-cyan-100"
        >
          刷新
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-0">
        <div className="flex min-h-0 flex-col border-r border-white/10">
          <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-2 font-mono text-xs text-slate-400">
            <MessageSquare size={14} className="text-cyan-300" />
            Claude Code conversation · slash commands are handled by runtime
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin" /> 初始化系统管家...
              </div>
            ) : error ? (
              <div className="text-xs text-red-300">初始化失败：{error}</div>
            ) : (
              <MessagesPanel
                teamName={SYSTEM_MANAGER_TEAM_NAME}
                position="inline"
                onPositionChange={() => {}}
                members={members}
                tasks={tasks}
                isTeamAlive={teamData?.isAlive ?? false}
                timeWindow={null}
                currentLeadSessionId={currentLeadSessionId}
                sessions={sessions}
                pendingRepliesByMember={pendingRepliesByMember}
                onPendingReplyChange={setPendingRepliesByMember}
              />
            )}
          </div>
        </div>

        <aside className="min-h-0 overflow-auto bg-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-300">
            <Terminal size={14} className="text-cyan-300" />
            Claude Code sessions
          </div>
          <CcSessionsSection
            teamName={SYSTEM_MANAGER_TEAM_NAME}
            sessions={sessions}
            loading={sessionsLoading}
            error={sessionsError}
          />
          <div className="mt-5 rounded border border-white/10 bg-black/20 p-3 text-[11px] leading-5 text-slate-400">
            <p className="text-slate-300">提示</p>
            <p className="mt-1">
              这里复用 Claude Code runtime。请输入 /help、/mcp、/hooks 等 Claude Code 自带命令，
              不再由 Hermit 维护写死快捷目标。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Run test to verify it passes**

Run:

```bash
pnpm test test/renderer/components/system-manager/SystemManagerView.test.tsx 2>&1 | tail -80
```

Expected: PASS. React `act(...)` warnings are acceptable if they match existing component-test behavior, but no assertion failures should remain.

---

### Task 3: Verify focused integration and type safety

**Files:**
- Modify: none unless verification finds a type/API mismatch.

- [ ] **Step 1: Run focused system-manager test**

Run:

```bash
pnpm test test/renderer/components/system-manager/SystemManagerView.test.tsx 2>&1 | tail -80
```

Expected: PASS.

- [ ] **Step 2: Run existing related tests**

Run:

```bash
pnpm test test/renderer/api/providers.test.ts test/main/utils/teamProjectResolution.test.ts test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.tsx test/renderer/store/teamSlice.test.ts 2>&1 | tail -80
```

Expected: PASS. These tests protect the recent slug-to-bindProject and provider-clearing fixes while this UI changes.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: `tsc --noEmit` exits 0.

---

## Self-Review

- Spec coverage: The plan removes hard-coded quick prompts, reuses existing Claude Code team messaging/session UI, keeps `system-manager -> my-project` behavior, and preserves Claude slash commands by routing through runtime instead of a fake terminal.
- Placeholder scan: No TBD/TODO placeholders are present.
- Type consistency: The plan uses existing exported names: `SystemManagerView`, `MessagesPanel`, `CcSessionsSection`, `api.teams.ensureSystemManager`, `api.teams.getTeamData`, `api.teams.getSessions`, `SYSTEM_MANAGER_TEAM_NAME`, and shared types already used elsewhere in the repository.

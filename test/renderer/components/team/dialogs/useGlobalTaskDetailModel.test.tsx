import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type GlobalTaskDetailModel,
  useGlobalTaskDetailModel,
} from '../../../../../src/renderer/components/team/dialogs/useGlobalTaskDetailModel';
import { useStore } from '../../../../../src/renderer/store';

import type { TeamViewSnapshot } from '../../../../../src/shared/types/team';

const originalState = useStore.getState();
let latestModel: GlobalTaskDetailModel | null = null;

function teamSnapshot(teamName: string, taskId: string): TeamViewSnapshot {
  return {
    teamName,
    config: {
      name: teamName,
      color: 'blue',
      description: '',
      agentType: 'claudecode',
      permissionMode: 'default',
      showContextIndicator: false,
      replyFooter: false,
      injectSender: false,
      managedSources: '*',
      disabledCommands: [],
      platformAllowFrom: {},
      platformAllowChat: {},
      projectPath: `/tmp/${teamName}`,
      members: [],
    },
    tasks: [{ id: taskId, subject: `${teamName} task`, status: 'pending' }],
    members: [],
    kanbanState: { teamName, reviewers: [], tasks: {} },
    processes: [],
    isAlive: false,
    platforms: [],
    harness: 'claudecode',
    bindProject: teamName,
    collaboration: true,
    description: '',
    workDir: `/tmp/${teamName}`,
    permissionMode: 'default',
    providerRefs: [],
    globalProviders: [],
    settings: {},
    heartbeat: null,
    activeSessions: [],
  } as unknown as TeamViewSnapshot;
}

function Probe({
  teamName,
  taskId,
}: Readonly<{ teamName: string; taskId: string }>): React.JSX.Element {
  latestModel = useGlobalTaskDetailModel(teamName, taskId);
  return <span>{latestModel.task?.id ?? 'missing'}</span>;
}

afterEach(() => {
  useStore.setState(originalState, true);
  latestModel = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useGlobalTaskDetailModel pane isolation', () => {
  it('reads and refreshes team-scoped cache without repointing global team selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const beta = teamSnapshot('beta', 'beta-task');
    const alpha = teamSnapshot('alpha', 'alpha-task');
    const refreshTeamData = vi.fn(() => Promise.resolve());
    useStore.setState({
      selectedTeamName: 'beta',
      selectedTeamData: beta,
      selectedTeamLoading: false,
      selectedTeamError: null,
      teamDataCacheByName: { alpha },
      memberActivityMetaByTeam: {},
      globalTasks: [],
      refreshTeamData,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<Probe teamName="alpha" taskId="alpha-task" />);
      await Promise.resolve();
    });

    expect(latestModel?.task?.id).toBe('alpha-task');
    expect(latestModel?.isFullTeamLoaded).toBe(true);
    expect(refreshTeamData).not.toHaveBeenCalled();
    expect(useStore.getState().selectedTeamName).toBe('beta');
    expect(useStore.getState().selectedTeamData?.teamName).toBe('beta');

    await act(async () => {
      root.render(<Probe teamName="gamma" taskId="gamma-task" />);
      await Promise.resolve();
    });
    expect(refreshTeamData).toHaveBeenCalledWith('gamma', { withDedup: true });
    expect(useStore.getState().selectedTeamName).toBe('beta');
    expect(useStore.getState().selectedTeamData?.teamName).toBe('beta');

    act(() => root.unmount());
  });
});

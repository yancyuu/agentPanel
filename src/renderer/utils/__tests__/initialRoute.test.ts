/**
 * restoreInitialRoute — maps the URL path to the matching tab action.
 *
 * This runs before React's first render (main.tsx) so the store holds the
 * correct tab on the first paint. These tests pin the path → action mapping
 * and the idempotent/empty-path behavior.
 */
import { describe, expect, it, vi } from 'vitest';

import { restoreInitialRoute } from '../initialRoute';

import type { AppState } from '@renderer/store/types';

function mockState(): AppState {
  return {
    openTeamTab: vi.fn(),
    openTeamsTab: vi.fn(),
    openSystemManager: vi.fn(),
    openSettingsTab: vi.fn(),
    openExtensionsTab: vi.fn(),
    openSchedulesTab: vi.fn(),
    openTasksTab: vi.fn(),
    openDashboard: vi.fn(),
    navigateToSession: vi.fn(),
    openTab: vi.fn(),
  } as unknown as AppState;
}

describe('restoreInitialRoute', () => {
  it('opens the teams tab for /teams', () => {
    const state = mockState();
    restoreInitialRoute(state, '/teams');
    expect(state.openTeamsTab).toHaveBeenCalledTimes(1);
  });

  it('opens a team tab for /team/:slug', () => {
    const state = mockState();
    restoreInitialRoute(state, '/team/hermit');
    expect(state.openTeamTab).toHaveBeenCalledWith('hermit');
  });

  it('decodes encoded path segments', () => {
    const state = mockState();
    restoreInitialRoute(state, '/team/%E6%88%91%E7%9A%84%E5%9B%A2%E9%98%9F');
    expect(state.openTeamTab).toHaveBeenCalledWith('我的团队');
  });

  it.each(['/', ''])('opens the inbox for the root path %j', (pathname) => {
    const state = mockState();
    restoreInitialRoute(state, pathname);
    expect(state.openTasksTab).toHaveBeenCalledTimes(1);
    expect(state.openTeamsTab).not.toHaveBeenCalled();
  });

  it.each([
    ['/tasks', 'openTasksTab'],
    ['/dashboard', 'openDashboard'],
    ['/settings', 'openSettingsTab'],
    ['/extensions', 'openExtensionsTab'],
    ['/schedules', 'openSchedulesTab'],
    ['/system-manager', 'openSystemManager'],
  ] as const)('preserves the existing %s deep link', (pathname, action) => {
    const state = mockState();
    restoreInitialRoute(state, pathname);
    expect(state[action]).toHaveBeenCalledTimes(1);
  });

  it('preserves the notifications deep link', () => {
    const state = mockState();
    restoreInitialRoute(state, '/notifications');
    expect(state.openTab).toHaveBeenCalledWith({ type: 'notifications', label: '通知' });
  });

  it('navigates to a session for /session/:project/:session', () => {
    const state = mockState();
    restoreInitialRoute(state, '/session/proj-1/sess-9');
    expect(state.navigateToSession).toHaveBeenCalledWith('proj-1', 'sess-9');
  });

  it('opens a graph tab for /graph/:team', () => {
    const state = mockState();
    restoreInitialRoute(state, '/graph/hermit');
    expect(state.openTab).toHaveBeenCalledWith({
      type: 'graph',
      label: 'hermit',
      teamName: 'hermit',
    });
  });

  it('opens a report tab for /report/:project/:session', () => {
    const state = mockState();
    restoreInitialRoute(state, '/report/proj-1/sess-9');
    expect(state.openTab).toHaveBeenCalledWith({
      type: 'report',
      label: 'Session Report',
      projectId: 'proj-1',
      sessionId: 'sess-9',
    });
  });

  it('ignores unknown routes', () => {
    const state = mockState();
    restoreInitialRoute(state, '/something-unknown');
    expect(state.openTab).not.toHaveBeenCalled();
    expect(state.openTeamsTab).not.toHaveBeenCalled();
  });

  it('trims and ignores leading/trailing slashes', () => {
    const state = mockState();
    restoreInitialRoute(state, '///teams///');
    expect(state.openTeamsTab).toHaveBeenCalledTimes(1);
  });
});

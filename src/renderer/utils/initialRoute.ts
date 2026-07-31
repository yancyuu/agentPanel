/**
 * Initial route restoration.
 *
 * Restores the active tab from the URL path SYNCHRONOUSLY, before React's first
 * render (called from main.tsx). Running this pre-render means the store already
 * holds the correct tab on the first paint — there is no blank content area
 * while a post-mount effect catches up, and the fallback view never double-mounts.
 */

import type { AppState } from '@renderer/store/types';

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Map the current URL path to the matching tab action. Idempotent: every action
 * dedupes against already-open tabs, so calling this more than once (e.g. HMR)
 * is safe.
 */
export function restoreInitialRoute(state: AppState, pathname: string): void {
  const segments = pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(safeDecodeURIComponent);

  if (segments.length === 0) {
    state.openInboxTab();
    return;
  }

  const [route, arg1, arg2] = segments;
  switch (route) {
    case 'team':
      if (arg1) state.openTeamTab(arg1);
      break;
    case 'teams':
      state.openTeamsTab();
      break;
    case 'system-manager':
      void state.openSystemManager();
      break;
    case 'settings':
      state.openSettingsTab();
      break;
    case 'extensions':
      state.openExtensionsTab();
      break;
    case 'schedules':
      state.openSchedulesTab();
      break;
    case 'inbox':
      state.openInboxTab();
      break;
    case 'tasks':
      state.openTasksTab();
      break;
    case 'collaboration':
      state.openTab({ type: 'collaboration', label: '协作团队' });
      break;
    case 'dashboard':
      state.openDashboard();
      break;
    case 'session':
      if (arg1 && arg2) {
        state.navigateToSession(arg1, arg2);
      }
      break;
    case 'notifications':
      state.openTab({ type: 'notifications', label: '通知' });
      break;
    case 'graph':
      if (arg1) {
        state.openTab({ type: 'graph', label: arg1, teamName: arg1 });
      }
      break;
    case 'report':
      if (arg1 && arg2) {
        state.openTab({
          type: 'report',
          label: 'Session Report',
          projectId: arg1,
          sessionId: arg2,
        });
      }
      break;
    default:
      break;
  }
}

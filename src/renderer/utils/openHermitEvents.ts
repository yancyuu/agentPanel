export const OPEN_HERMIT_EVENTS = {
  providersChanged: 'openhermit:providers-changed',
  teamsChanged: 'openhermit:teams-changed',
  runtimeRestarted: 'openhermit:runtime-restarted',
  createTeamFromProject: 'openhermit:create-team-from-project',
} as const;

export interface CreateTeamFromProjectEventDetail {
  projectPath: string;
}

export function emitOpenHermitEvent(eventName: string): void {
  window.dispatchEvent(new Event(eventName));
}

export function emitCreateTeamFromProjectIntent(projectPath: string): void {
  const trimmedPath = projectPath.trim();
  if (!trimmedPath) return;

  window.dispatchEvent(
    new CustomEvent<CreateTeamFromProjectEventDetail>(OPEN_HERMIT_EVENTS.createTeamFromProject, {
      detail: { projectPath: trimmedPath },
    })
  );
}

export function getCreateTeamFromProjectPath(event: Event): string | null {
  const detail = (event as CustomEvent<Partial<CreateTeamFromProjectEventDetail>>).detail;
  const projectPath = detail?.projectPath;
  if (typeof projectPath !== 'string') return null;

  const trimmedPath = projectPath.trim();
  return trimmedPath.length > 0 ? trimmedPath : null;
}

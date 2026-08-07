import type { TeamManifest } from '@main/services/team-management/TeamWorkspaceService';

export async function resolveCcProjectName(
  routeTeamName: string,
  readTeamManifest: (teamName: string) => Promise<TeamManifest>
): Promise<string> {
  try {
    const manifest = await readTeamManifest(routeTeamName);
    const bindProject = manifest.bindProject?.trim();
    if (bindProject) return bindProject;
  } catch {
    // routeTeamName may already be a cc-connect project name.
  }
  return routeTeamName;
}

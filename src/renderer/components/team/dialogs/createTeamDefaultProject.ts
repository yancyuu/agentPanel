import { normalizePath } from '@renderer/utils/pathNormalize';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type { Project } from '@shared/types';

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[/\\]/).filter(Boolean).pop() ?? projectPath;
}

function buildDefaultProject(defaultProjectPath: string): Project {
  return {
    id: `recent:${defaultProjectPath}`,
    path: defaultProjectPath,
    name: projectNameFromPath(defaultProjectPath),
    sessions: [],
    totalSessions: 0,
    createdAt: 0,
    mostRecentSession: undefined,
  };
}

export function buildSelectableProjectsWithDefaultPath(
  projects: readonly Project[],
  defaultProjectPath: string | null | undefined
): Project[] {
  const selectable = projects.filter((project) => !isEphemeralProjectPath(project.path));
  if (!defaultProjectPath || isEphemeralProjectPath(defaultProjectPath)) {
    return selectable;
  }

  const normalizedDefaultPath = normalizePath(defaultProjectPath);
  const hasDefaultProject = selectable.some(
    (project) => normalizePath(project.path) === normalizedDefaultPath
  );
  if (hasDefaultProject) {
    return selectable;
  }

  return [buildDefaultProject(defaultProjectPath), ...selectable];
}

export function findProjectPathMatch(
  projects: readonly Project[],
  projectPath: string | null | undefined
): string | null {
  if (!projectPath || isEphemeralProjectPath(projectPath)) {
    return null;
  }

  const normalizedProjectPath = normalizePath(projectPath);
  return (
    projects.find((project) => normalizePath(project.path) === normalizedProjectPath)?.path ?? null
  );
}

import { describe, expect, it } from 'vitest';

import {
  buildSelectableProjectsWithDefaultPath,
  findProjectPathMatch,
} from '@renderer/components/team/dialogs/createTeamDefaultProject';

import type { Project } from '@shared/types';

function project(path: string): Project {
  return {
    id: path,
    path,
    name: path.split('/').pop() ?? path,
    sessions: [],
    totalSessions: 0,
    createdAt: 0,
  };
}

describe('createTeamDefaultProject', () => {
  it('adds the recent project path as a selectable project when the API list does not include it', () => {
    const projects = [project('/Users/test/code/other')];

    const selectable = buildSelectableProjectsWithDefaultPath(
      projects,
      '/Users/test/code/hermit'
    );

    expect(selectable.map((item) => item.path)).toEqual([
      '/Users/test/code/hermit',
      '/Users/test/code/other',
    ]);
    expect(selectable[0]).toMatchObject({
      id: 'recent:/Users/test/code/hermit',
      name: 'hermit',
      sessions: [],
      totalSessions: 0,
    });
  });

  it('uses the canonical project entry when the recent path already exists in the project list', () => {
    const projects = [project('/Users/test/code/hermit')];

    const selectable = buildSelectableProjectsWithDefaultPath(
      projects,
      '/Users/test/code/hermit/'
    );

    expect(selectable).toEqual(projects);
    expect(findProjectPathMatch(selectable, '/Users/test/code/hermit/')).toBe(
      '/Users/test/code/hermit'
    );
  });
});

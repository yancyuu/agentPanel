import { describe, expect, it } from 'vitest';

import { resolveCcProjectName } from '../../../src/main/utils/teamProjectResolution';

import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';

const manifest: TeamManifest = {
  schemaVersion: 2,
  slug: 'system-manager',
  displayName: '控制台',
  bindProject: 'my-project',
  harness: 'claudecode',
  workDir: '/repo',
  collaboration: false,
  rootPath: '/tmp/system-manager',
  createdAt: '2026-06-05T00:00:00.000Z',
};

describe('resolveCcProjectName', () => {
  it('uses a local team manifest bindProject when the route name is a team slug', async () => {
    const projectName = await resolveCcProjectName('system-manager', async (teamName) => {
      expect(teamName).toBe('system-manager');
      return manifest;
    });

    expect(projectName).toBe('my-project');
  });

  it('falls back to the route name when no local manifest exists', async () => {
    const projectName = await resolveCcProjectName('external-project', async () => {
      throw new Error('not found');
    });

    expect(projectName).toBe('external-project');
  });

  it('falls back to the route name when bindProject is blank', async () => {
    const projectName = await resolveCcProjectName('blank-bind', async () => ({
      ...manifest,
      slug: 'blank-bind',
      bindProject: '   ',
    }));

    expect(projectName).toBe('blank-bind');
  });

  it('trims a populated bindProject before returning it', async () => {
    const projectName = await resolveCcProjectName('padded', async () => ({
      ...manifest,
      slug: 'padded',
      bindProject: '  real-project  ',
    }));

    expect(projectName).toBe('real-project');
  });
});

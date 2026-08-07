import { describe, expect, it } from 'vitest';

import { discoverableTeamToWorker } from './worker';

import type { DiscoverableTeam } from './team';

function makeTeam(overrides: Partial<DiscoverableTeam> = {}): DiscoverableTeam {
  return {
    slug: 'team-1',
    displayName: '产品助手',
    location: 'local',
    status: 'online',
    collaboration: true,
    ...overrides,
  };
}

describe('discoverableTeamToWorker', () => {
  it('forwards the workDir so /workers can show where each team lives', () => {
    const worker = discoverableTeamToWorker(makeTeam({ workDir: '/Users/x/projects/demo' }));
    expect(worker.workerId).toBe('team-1');
    expect(worker.workDir).toBe('/Users/x/projects/demo');
  });

  it('leaves workDir undefined when the team manifest has none', () => {
    const worker = discoverableTeamToWorker(makeTeam());
    expect(worker.workDir).toBeUndefined();
  });
});

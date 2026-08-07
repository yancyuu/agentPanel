import { describe, expect, it } from 'vitest';

import { analyzeTeammateRuntimeCompatibility } from '@renderer/components/team/dialogs/teammateRuntimeCompatibility';

describe('analyzeTeammateRuntimeCompatibility', () => {
  it('allows same-provider teammates without tmux', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'alice', name: 'alice', providerId: 'anthropic' }],
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.memberWarningById).toEqual({});
  });

  it('allows mixed-provider member drafts because launch inherits the team provider', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'bob', name: 'bob', providerId: 'codex' }],
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.memberWarningById).toEqual({});
  });

  it('ignores teammate runtime requirements for solo teams', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'codex',
      members: [{ id: 'jack', name: 'jack', providerId: 'codex' }],
      soloTeam: true,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
  });

  it('warns but does not block when old custom args request tmux mode', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'alice', name: 'alice', providerId: 'anthropic' }],
      extraCliArgs: '--teammate-mode tmux',
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(true);
    expect(result.details.some((detail) => detail.includes('--teammate-mode'))).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  expandCapabilityCommand,
  resolveCapabilityCommandInput,
} from '@renderer/utils/capabilityCommandExecution';

import type { RegisteredSlashCommand } from '@shared/types/extensions';

const { promptApi } = vi.hoisted(() => ({
  promptApi: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    capabilityPacks: {
      getCommandPrompt: promptApi,
    },
  },
}));

function makeCommand(overrides: Partial<RegisteredSlashCommand> = {}): RegisteredSlashCommand {
  return {
    canonicalId: 'pack.doctor',
    alias: 'doctor',
    namespace: 'ops',
    slash: '/doctor',
    namespacedSlash: '/ops:doctor',
    source: 'pack',
    packId: 'pack',
    command: {
      id: 'doctor',
      alias: 'doctor',
      title: 'Loop Doctor',
      description: 'Diagnose loop state',
      scope: ['team-loop'],
      surfaces: ['slash'],
      safety: 'read-only',
      prompt: 'commands/doctor.md',
      execution: { type: 'send-message', reuse: true },
    },
    ...overrides,
  };
}

describe('capabilityCommandExecution', () => {
  it('resolves selected commandRef directly when the inserted slash still matches', () => {
    const first = makeCommand();
    const second = makeCommand({ canonicalId: 'other.doctor', namespace: 'other', packId: 'other' });

    const result = resolveCapabilityCommandInput([first, second], '/doctor check logs', {
      commandRef: 'pack.doctor',
      command: '/doctor',
    });

    expect(result.status).toBe('resolved');
    expect(result.resolved?.command.canonicalId).toBe('pack.doctor');
    expect(result.resolved?.args).toBe('check logs');
  });

  it('ignores typed reserved aliases so official commands can still be sent', () => {
    const command = makeCommand({
      canonicalId: 'pack.loop',
      alias: 'loop',
      namespacedSlash: '/ops:loop',
      command: { ...makeCommand().command, id: 'loop', alias: 'loop' },
      conflictsWith: ['official.loop'],
    });

    const result = resolveCapabilityCommandInput([command], '/loop check', null, {
      shadowedAliases: new Set(['loop']),
    });

    expect(result.status).toBe('not-found');
  });

  it('reports typed alias conflicts instead of picking a default command', () => {
    const first = makeCommand();
    const second = makeCommand({ canonicalId: 'other.doctor', namespace: 'other', packId: 'other' });

    const result = resolveCapabilityCommandInput([first, second], '/doctor');

    expect(result.status).toBe('conflict');
  });

  it('expands prompt content and appends user args', async () => {
    const command = makeCommand();
    promptApi.mockResolvedValueOnce({ command, prompt: '# Doctor\nCheck runtime.' });

    const result = await expandCapabilityCommand({ command, raw: '/doctor focus', args: 'focus' }, 'team-loop');

    expect(promptApi).toHaveBeenCalledWith({ canonicalId: 'pack.doctor', scope: 'team-loop' });
    expect(result.text).toContain('# Doctor\nCheck runtime.');
    expect(result.text).toContain('User arguments:\nfocus');
    expect(result.slashCommand).toMatchObject({
      name: 'doctor',
      command: '/ops:doctor',
      args: 'focus',
      knownDescription: 'Diagnose loop state',
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildCapabilityPackCommandSuggestions,
  buildSlashCommandRegistry,
  collectSlashSuggestionAliases,
  resolveSlashCommand,
  sourceLabel,
} from '@renderer/utils/slashCommandRegistry';

import type { LoadedCapabilityPack } from '@shared/types/extensions';

function makePack(overrides: Partial<LoadedCapabilityPack> = {}): LoadedCapabilityPack {
  return {
    packDir: '/tmp/yancy-loop-ops',
    source: 'user',
    enabled: true,
    warnings: [],
    manifest: {
      schemaVersion: 1,
      id: 'yancy-loop-ops',
      name: 'Yancy Loop Ops',
      namespace: 'yancy',
      version: '1.0.0',
      capabilities: {
        commands: [
          {
            id: 'doctor',
            alias: 'doctor',
            title: 'Loop Doctor',
            description: 'Diagnose Loop runtime',
            scope: ['admin-loop', 'team-loop'],
            surfaces: ['slash'],
            safety: 'read-only',
            prompt: 'commands/doctor.md',
            order: 10,
          },
        ],
        skills: [],
        workflows: [],
      },
    },
    ...overrides,
  };
}

describe('slashCommandRegistry', () => {
  it('registers scoped pack commands with canonical and namespaced slash ids', () => {
    const registry = buildSlashCommandRegistry({ packs: [makePack()], scope: 'admin-loop' });

    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      canonicalId: 'yancy-loop-ops.doctor',
      alias: 'doctor',
      namespace: 'yancy',
      slash: '/doctor',
      namespacedSlash: '/yancy:doctor',
      source: 'pack',
      packId: 'yancy-loop-ops',
    });
    expect(registry[0]?.command.execution).toEqual({ type: 'loop-session', reuse: true });
  });

  it('filters commands outside the requested scope', () => {
    const registry = buildSlashCommandRegistry({
      packs: [
        makePack({
          manifest: {
            ...makePack().manifest,
            capabilities: {
              commands: [
                {
                  id: 'card-only',
                  alias: 'card-only',
                  title: 'Card only',
                  scope: ['kanban-card'],
                  surfaces: ['slash'],
                  safety: 'proposal-only',
                  prompt: 'commands/card-only.md',
                },
              ],
            },
          },
        }),
      ],
      scope: 'team-loop',
    });

    expect(registry).toEqual([]);
  });

  it('marks alias conflicts and refuses typed ambiguous aliases', () => {
    const otherPack = makePack({
      packDir: '/tmp/other',
      manifest: {
        ...makePack().manifest,
        id: 'other-pack',
        namespace: 'other',
      },
    });
    const registry = buildSlashCommandRegistry({ packs: [makePack(), otherPack], scope: 'team-loop' });

    expect(registry.every((entry) => entry.conflictsWith?.length)).toBe(true);
    expect(resolveSlashCommand(registry, '/doctor').status).toBe('conflict');
    expect(resolveSlashCommand(registry, '/yancy:doctor')).toMatchObject({
      status: 'resolved',
      command: { canonicalId: 'yancy-loop-ops.doctor' },
    });
    expect(resolveSlashCommand(registry, '/yancy:doctor:prod').status).toBe('not-found');
  });

  it('filters namespaces containing namespaced slash separators', () => {
    const registry = buildSlashCommandRegistry({
      packs: [makePack({ manifest: { ...makePack().manifest, namespace: 'bad:namespace' } })],
      scope: 'team-loop',
    });

    expect(registry).toEqual([]);
  });

  it('protects official reserved aliases by suggesting the namespaced slash', () => {
    const pack = makePack({
      manifest: {
        ...makePack().manifest,
        capabilities: {
          commands: [
            {
              id: 'help',
              alias: 'help',
              title: 'Pack Help',
              scope: ['team-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/help.md',
            },
          ],
        },
      },
    });

    const [suggestion] = buildCapabilityPackCommandSuggestions([pack], 'team-loop');

    expect(suggestion?.command).toBe('/yancy:help');
    expect(suggestion?.commandRef).toBe('yancy-loop-ops.help');
    expect(resolveSlashCommand(buildSlashCommandRegistry({ packs: [pack] }), '/help').status).toBe(
      'conflict'
    );
  });

  it('protects built-in runtime aliases beyond the manually reserved list', () => {
    const pack = makePack({
      manifest: {
        ...makePack().manifest,
        capabilities: {
          commands: [
            {
              id: 'loop',
              alias: 'loop',
              title: 'Pack Loop',
              scope: ['team-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/loop.md',
            },
          ],
        },
      },
    });

    const [suggestion] = buildCapabilityPackCommandSuggestions([pack], 'team-loop');

    expect(suggestion?.command).toBe('/yancy:loop');
    expect(resolveSlashCommand(buildSlashCommandRegistry({ packs: [pack] }), '/loop').status).toBe(
      'conflict'
    );
  });

  it('uses namespaced suggestions when local commands shadow pack aliases', () => {
    const pack = makePack();
    const [suggestion] = buildCapabilityPackCommandSuggestions([pack], 'team-loop', {
      forceNamespacedAliases: new Set(['doctor']),
    });

    expect(suggestion?.command).toBe('/yancy:doctor');
    expect(suggestion?.insertText).toBe('yancy:doctor');
  });

  it('collects short aliases from local slash suggestions only', () => {
    const aliases = collectSlashSuggestionAliases([
      { id: 'local:doctor', name: 'doctor', type: 'command', command: '/doctor', insertText: 'doctor' },
      {
        id: 'pack:doctor',
        name: 'yancy:doctor',
        type: 'command',
        command: '/yancy:doctor',
        insertText: 'yancy:doctor',
        commandRef: 'yancy-loop-ops.doctor',
      },
      { id: 'local:summary', name: 'summary', type: 'command', command: '/summary fast', insertText: 'summary' },
    ]);

    expect([...aliases].sort()).toEqual(['doctor', 'summary']);
  });

  it('skips disabled packs and builtin packs', () => {
    const disabled = makePack({ enabled: false });
    const builtin = makePack({ source: 'builtin' });
    expect(buildSlashCommandRegistry({ packs: [disabled, builtin], scope: 'team-loop' })).toEqual(
      []
    );
  });

  it('skips commands that do not expose the slash surface', () => {
    const pack = makePack({
      manifest: {
        ...makePack().manifest,
        capabilities: {
          commands: [
            {
              id: 'no-slash',
              alias: 'no-slash',
              title: 'No Slash',
              scope: ['team-loop'],
              surfaces: ['quick-run'],
              safety: 'read-only',
              prompt: 'commands/no-slash.md',
            },
          ],
        },
      },
    });
    expect(buildSlashCommandRegistry({ packs: [pack], scope: 'team-loop' })).toEqual([]);
  });

  it('uses workflow metadata as the admin command description when command description is missing', () => {
    const pack = makePack({
      manifest: {
        ...makePack().manifest,
        capabilities: {
          commands: [
            {
              id: 'doctor',
              alias: 'doctor',
              title: 'Loop Doctor',
              scope: ['admin-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/doctor.md',
              workflow: 'doctor.md',
            },
          ],
          workflows: [
            {
              id: 'doctor',
              name: 'Loop Doctor',
              description: 'Diagnose runtime, config, MCP, cron, and project assets.',
              path: 'workflows/doctor.md',
            },
          ],
        },
      },
    });

    const [suggestion] = buildCapabilityPackCommandSuggestions([pack], 'admin-loop');

    expect(suggestion?.description).toBe('Diagnose runtime, config, MCP, cron, and project assets.');
    expect(suggestion?.searchText).toContain('Diagnose runtime');
  });

  it('sorts registered commands by order then alias', () => {
    const pack = makePack({
      manifest: {
        ...makePack().manifest,
        capabilities: {
          commands: [
            {
              id: 'zeta',
              alias: 'zeta',
              title: 'Zeta',
              scope: ['team-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/zeta.md',
              order: 1,
            },
            {
              id: 'alpha',
              alias: 'alpha',
              title: 'Alpha',
              scope: ['team-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/alpha.md',
              order: 1,
            },
          ],
        },
      },
    });
    const registry = buildSlashCommandRegistry({ packs: [pack], scope: 'team-loop' });
    expect(registry.map((entry) => entry.alias)).toEqual(['alpha', 'zeta']);
  });
});

describe('resolveSlashCommand commandRef and empty inputs', () => {
  const registry = buildSlashCommandRegistry({ packs: [makePack()], scope: 'team-loop' });

  it('resolves by canonical commandRef directly, ignoring input text', () => {
    expect(resolveSlashCommand(registry, '', 'yancy-loop-ops.doctor')).toMatchObject({
      status: 'resolved',
      command: { canonicalId: 'yancy-loop-ops.doctor' },
    });
  });

  it('returns not-found for an unknown commandRef', () => {
    expect(resolveSlashCommand(registry, '/anything', 'missing.id').status).toBe('not-found');
  });

  it('returns not-found for empty input without a commandRef', () => {
    expect(resolveSlashCommand(registry, '').status).toBe('not-found');
    expect(resolveSlashCommand(registry, '   ').status).toBe('not-found');
  });

  it('rejects malformed namespaced inputs', () => {
    expect(resolveSlashCommand(registry, '/a:b:c').status).toBe('not-found');
    expect(resolveSlashCommand(registry, '/:doctor').status).toBe('not-found');
    expect(resolveSlashCommand(registry, '/yancy:').status).toBe('not-found');
  });
});

describe('sourceLabel', () => {
  it('labels each source', () => {
    expect(sourceLabel('builtin')).toBe('Built-in');
    expect(sourceLabel('official')).toBe('Official');
    expect(sourceLabel('project')).toBe('Project');
    expect(sourceLabel('pack')).toBe('Capability pack');
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCapabilityPackRoutes } from '../../../src/main/routes/capabilityPackRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
const tempDirs: string[] = [];
type Dependencies = Parameters<typeof registerCapabilityPackRoutes>[1];

function createHarness(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const handlers = {
    capabilityPacksList: vi.fn(() => Promise.resolve({ success: true, data: { packs: [] } })),
    capabilityPacksImport: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
    capabilityPacksExport: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
    capabilityPacksCommandPrompt: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
    ...overrides,
  } as unknown as Dependencies['handlers'];
  const setLocalSource = vi.fn<Dependencies['setLocalSource']>();
  const setSkillsWatcherEmitter = vi.fn<Dependencies['setSkillsWatcherEmitter']>();
  const broadcastSse = vi.fn<Dependencies['broadcastSse']>();
  const localSource: Dependencies['localSource'] = {
    projectPath: '/repo',
    listCronJobs: vi.fn(() => Promise.resolve([])),
    listTeams: vi.fn(() => Promise.resolve([])),
  };
  registerCapabilityPackRoutes(app, {
    handlers,
    localSource,
    setLocalSource,
    setSkillsWatcherEmitter,
    broadcastSse,
  });
  return { app, handlers, localSource, setLocalSource, setSkillsWatcherEmitter, broadcastSse };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('capability pack routes', () => {
  it('wires the local source and skills watcher SSE emitter during registration', () => {
    const harness = createHarness();

    expect(harness.setLocalSource).toHaveBeenCalledWith(harness.localSource);
    expect(harness.setSkillsWatcherEmitter).toHaveBeenCalledOnce();
    const emit = harness.setSkillsWatcherEmitter.mock.calls[0][0];
    const event = { type: 'change', path: '/repo/.claude/skills/demo' } as Parameters<
      typeof emit
    >[0];
    emit(event);
    expect(harness.broadcastSse).toHaveBeenCalledWith('skills:changed', event);
  });

  it('forwards list, import, export, and command-prompt payloads', async () => {
    const { app, handlers } = createHarness();
    const payload = { packId: 'pack-a', target: 'team-a' };

    await app.inject({ method: 'GET', url: '/api/extensions/capability-packs' });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/import',
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/export',
      payload,
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/command-prompt',
      payload,
    });

    expect(handlers.capabilityPacksList).toHaveBeenCalledOnce();
    expect(handlers.capabilityPacksImport).toHaveBeenCalledWith(payload);
    expect(handlers.capabilityPacksExport).toHaveBeenCalledWith(payload);
    expect(handlers.capabilityPacksCommandPrompt).toHaveBeenCalledWith(payload);
  });

  it('returns export failures and missing directories with the existing status contracts', async () => {
    const failed = createHarness({
      capabilityPacksExport: vi.fn(() =>
        Promise.resolve({ success: false, error: 'cannot export' })
      ),
    });
    const missing = createHarness({
      capabilityPacksExport: vi.fn(() => Promise.resolve({ success: true, data: { pack: {} } })),
    });

    const failedResponse = await failed.app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/export/download',
      payload: {},
    });
    const missingResponse = await missing.app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/export/download',
      payload: {},
    });

    expect(failedResponse.statusCode).toBe(400);
    expect(failedResponse.json()).toEqual({ success: false, error: 'cannot export' });
    expect(missingResponse.statusCode).toBe(500);
    expect(missingResponse.json()).toEqual({
      success: false,
      error: 'Exported capability pack directory is missing',
    });
  });

  it('streams a sanitized ZIP download with warning headers and excludes dotfiles', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-capability-pack-'));
    tempDirs.push(directory);
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested', 'command.md'), '# command', 'utf8');
    await writeFile(path.join(directory, '.secret'), 'hidden', 'utf8');
    const harness = createHarness({
      capabilityPacksExport: vi.fn(() =>
        Promise.resolve({
          success: true,
          data: {
            pack: { packDir: directory, manifest: { id: 'Team Pack / 中文' } },
            warnings: ['missing optional skill'],
          },
        })
      ),
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/extensions/capability-packs/export/download',
      payload: { teamName: 'team-a' },
    });
    const zipText = response.rawPayload.toString('utf8');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Team-Pack.zip"');
    expect(response.headers['x-capability-pack-warnings']).toBe(
      encodeURIComponent(JSON.stringify(['missing optional skill']))
    );
    expect(response.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipText).toContain('nested/command.md');
    expect(zipText).toContain('# command');
    expect(zipText).not.toContain('.secret');
    expect(zipText).not.toContain('hidden');
  });
});

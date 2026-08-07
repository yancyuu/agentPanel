import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerExtensionPluginRoutes } from '../../../src/main/routes/extensionPluginRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerExtensionPluginRoutes>[1];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const handlers = {
    pluginGetAll: vi.fn(() => Promise.resolve({ success: true, data: ['plugin-a'] })),
    pluginGetReadme: vi.fn((pluginId: string) =>
      Promise.resolve({ success: true, data: pluginId })
    ),
    pluginInstall: vi.fn((request: unknown) => Promise.resolve({ success: true, data: request })),
    pluginUninstall: vi.fn((...args: unknown[]) => Promise.resolve({ success: true, data: args })),
  } as unknown as Dependencies['handlers'];
  registerExtensionPluginRoutes(app, { handlers });
  return { app, handlers };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('extension plugin routes', () => {
  it('forwards list, readme, and install requests without changing payloads', async () => {
    const { app, handlers } = createHarness();

    expect((await app.inject({ method: 'GET', url: '/api/extensions/plugins' })).json()).toEqual({
      success: true,
      data: ['plugin-a'],
    });
    await app.inject({ method: 'GET', url: '/api/extensions/plugins/readme/plugin-a' });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/plugins/install',
      payload: { pluginId: 'plugin-a', scope: 'project', projectPath: '/tmp/project' },
    });

    expect(handlers.pluginGetReadme).toHaveBeenCalledWith('plugin-a');
    expect(handlers.pluginInstall).toHaveBeenCalledWith({
      pluginId: 'plugin-a',
      scope: 'project',
      projectPath: '/tmp/project',
    });
  });

  it('preserves uninstall positional arguments including harness type', async () => {
    const { app, handlers } = createHarness();

    await app.inject({
      method: 'POST',
      url: '/api/extensions/plugins/uninstall',
      payload: {
        pluginId: 'plugin-a',
        scope: 'project',
        projectPath: '/tmp/project',
        harnessType: 'codex',
      },
    });

    expect(handlers.pluginUninstall).toHaveBeenCalledWith(
      'plugin-a',
      'project',
      '/tmp/project',
      'codex'
    );
  });
});

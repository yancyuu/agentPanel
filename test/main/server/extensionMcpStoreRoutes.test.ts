import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerExtensionMcpStoreRoutes } from '../../../src/main/routes/extensionMcpStoreRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerExtensionMcpStoreRoutes>[1];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const handlers = {
    mcpGetInstalled: vi.fn((projectPath?: string) =>
      Promise.resolve({ success: true, data: projectPath })
    ),
    mcpInstallCustom: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
    mcpUninstall: vi.fn((...args: unknown[]) => Promise.resolve({ success: true, data: args })),
    mcpLibraryList: vi.fn(() => Promise.resolve({ success: true, data: [] })),
    mcpLibraryUpsert: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
    mcpLibraryDelete: vi.fn((id: string) => Promise.resolve({ success: true, data: id })),
    mcpLibraryImport: vi.fn((request: unknown) =>
      Promise.resolve({ success: true, data: request })
    ),
  } as unknown as Dependencies['handlers'];
  registerExtensionMcpStoreRoutes(app, { handlers });
  return { app, handlers };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('extension MCP store routes', () => {
  it('forwards installed, custom install, and uninstall inputs', async () => {
    const { app, handlers } = createHarness();

    await app.inject({
      method: 'GET',
      url: '/api/extensions/mcp/installed?projectPath=%2Ftmp%2Fproject',
    });
    const install = { serverName: 'demo', installSpec: { command: 'demo' } };
    await app.inject({
      method: 'POST',
      url: '/api/extensions/mcp/install-custom',
      payload: install,
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/mcp/uninstall',
      payload: {
        name: 'demo',
        scope: 'project',
        projectPath: '/tmp/project',
        harnessType: 'codex',
      },
    });

    expect(handlers.mcpGetInstalled).toHaveBeenCalledWith('/tmp/project');
    expect(handlers.mcpInstallCustom).toHaveBeenCalledWith(install);
    expect(handlers.mcpUninstall).toHaveBeenCalledWith('demo', 'project', '/tmp/project', 'codex');
  });

  it('preserves MCP library CRUD and import routing', async () => {
    const { app, handlers } = createHarness();
    const entry = { id: 'server-a', name: 'Server A' };

    await app.inject({ method: 'GET', url: '/api/extensions/mcp/library' });
    await app.inject({ method: 'POST', url: '/api/extensions/mcp/library', payload: entry });
    await app.inject({ method: 'DELETE', url: '/api/extensions/mcp/library/server-a' });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/mcp/library/import',
      payload: { source: 'live' },
    });

    expect(handlers.mcpLibraryList).toHaveBeenCalledOnce();
    expect(handlers.mcpLibraryUpsert).toHaveBeenCalledWith(entry);
    expect(handlers.mcpLibraryDelete).toHaveBeenCalledWith('server-a');
    expect(handlers.mcpLibraryImport).toHaveBeenCalledWith({ source: 'live' });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createPanelApiClient, resolvePanelBaseUrl } from '../panelApi.mjs';

describe('panelApi', () => {
  it('prefers an explicit port, then workbench URL, then desktop metadata', () => {
    expect(resolvePanelBaseUrl({ cliArgs: ['--port', '8123'], defaultPort: '8123' })).toBe(
      'http://127.0.0.1:8123'
    );
    expect(
      resolvePanelBaseUrl({
        cliArgs: [],
        defaultPort: '5680',
        env: { HERMIT_WORKBENCH_URL: 'http://127.0.0.1:9999/' },
      })
    ).toBe('http://127.0.0.1:9999');
    expect(
      resolvePanelBaseUrl({
        cliArgs: [],
        defaultPort: '5680',
        env: {},
        metadata: { origin: 'http://127.0.0.1:7788/' },
      })
    ).toBe('http://127.0.0.1:7788');
  });

  it('sends the desktop token and unwraps the Workbench response envelope', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, data: { enabled: false } }),
    }));
    const client = createPanelApiClient({
      baseUrl: 'http://127.0.0.1:5680/',
      sessionToken: 'desktop-token',
      fetchImpl,
    });

    await expect(
      client.request('/api/example', { method: 'PUT', body: { enabled: true } })
    ).resolves.toEqual({
      enabled: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5680/api/example',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-agentpanel-desktop-token': 'desktop-token',
        }),
        body: JSON.stringify({ enabled: true }),
      })
    );
  });

  it('reports a local Workbench error instead of falling back to direct file mutation', async () => {
    const client = createPanelApiClient({
      baseUrl: 'http://127.0.0.1:5680',
      fetchImpl: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });

    await expect(client.request('/api/example')).rejects.toThrow('工作台未启动或不可达');
  });
});

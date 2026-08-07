import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

describe('HttpAPIClient terminal API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts openExternal commands to the system terminal endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpAPIClient('http://127.0.0.1:5681');
    await client.terminal.openExternal({ command: 'claude', args: ['/loop-scan'], cwd: '/repo' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5681/api/terminal/open-external',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ command: 'claude', args: ['/loop-scan'], cwd: '/repo' }),
      })
    );
  });
});

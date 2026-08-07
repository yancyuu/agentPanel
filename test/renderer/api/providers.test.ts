import { afterEach, describe, expect, it, vi } from 'vitest';

import { providersApi } from '../../../src/renderer/api/providers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('providersApi', () => {
  it('uses the current Workbench origin so alternate ports reach the bridge proxy', async () => {
    window.history.replaceState({}, '', '/settings');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { providers: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await providersApi.list();

    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/api/v1/providers`,
      expect.any(Object)
    );
  });

  it('serializes undefined update fields as null so cc-connect can clear stale values', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { message: 'ok' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await providersApi.update('custom', { base_url: undefined, model: undefined });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/providers/custom'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ base_url: null, model: null }),
      })
    );
  });
});

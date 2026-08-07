import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

describe('HttpAPIClient cc settings', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads message attachments from the team message attachment route', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ id: 'a1', data: 'base64', mimeType: 'image/png' }]), {
          status: 200,
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpAPIClient('http://localhost:9999');
    await expect(client.teams.getAttachments('team one', 'msg/1')).resolves.toEqual([
      { id: 'a1', data: 'base64', mimeType: 'image/png' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/api/teams/team%20one/messages/msg%2F1/attachments',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('allows cc-connect restart to take longer than the default 10 second request timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);

    let requestSignal: AbortSignal | undefined;
    let resolved = false;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        }, 11_000);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpAPIClient('http://localhost:9999');
    const restartPromise = client.ccSettings.restart().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(false);
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await restartPromise;

    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/api/cc-restart',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

describe('HttpAPIClient exact task logs browser fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns safe fallback shapes for exact task logs in browser mode', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock fetch to simulate server not available
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
    const client = new HttpAPIClient('http://localhost:9999');

    await expect(client.teams.getTaskLogStream('demo', 'task-a')).resolves.toEqual({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });

    // Second and third calls use their own response shapes
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(client.teams.getTaskExactLogSummaries('demo', 'task-a')).resolves.toEqual({
      items: [],
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'missing',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(
      client.teams.getTaskExactLogDetail('demo', 'task-a', 'bundle-1', 'gen-1')
    ).resolves.toEqual({ status: 'missing' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

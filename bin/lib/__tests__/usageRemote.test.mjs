import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatUploadProviders,
  normalizeUploadProviders,
  uploadProviderLabel,
} from '../usageRemote.mjs';

describe('usageRemote provider helpers', () => {
  it('normalizeUploadProviders parses, dedups, and filters to known providers', () => {
    expect(normalizeUploadProviders('claudecode')).toEqual(['claudecode']);
    expect(normalizeUploadProviders('claudecode,codex,pi')).toEqual(['claudecode', 'codex', 'pi']);
    expect(normalizeUploadProviders(['claudecode', 'claudecode'])).toEqual(['claudecode']);
    expect(normalizeUploadProviders('pi+codex+claudecode')).toEqual(['pi', 'codex', 'claudecode']);
    expect(normalizeUploadProviders('invalid,claudecode')).toEqual(['claudecode']);
    expect(normalizeUploadProviders('')).toEqual([]);
    expect(normalizeUploadProviders(null)).toEqual([]);
  });

  it('uploadProviderLabel maps known ids and passes unknown through', () => {
    expect(uploadProviderLabel('claudecode')).toBe('Claude Code');
    expect(uploadProviderLabel('codex')).toBe('Codex');
    expect(uploadProviderLabel('pi')).toBe('Pi');
    expect(uploadProviderLabel('mystery')).toBe('mystery');
  });

  it('formatUploadProviders joins labels or reports 未选择', () => {
    expect(formatUploadProviders(['claudecode', 'codex', 'pi'])).toBe('Claude Code + Codex + Pi');
    expect(formatUploadProviders('claudecode')).toBe('Claude Code');
    expect(formatUploadProviders([])).toBe('未选择');
  });
});

describe('usageRemote fetch short-circuits when unauthenticated', () => {
  let tmpHome;
  let fetchMock;

  beforeAll(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-usage-remote-'));
    process.env.HERMIT_HOME = tmpHome;
    vi.resetModules();
  });

  afterAll(async () => {
    delete process.env.HERMIT_HOME;
    delete process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL;
    await rm(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('fetchRemoteUsageStatus returns 等待登录 without calling the server', async () => {
    const { fetchRemoteUsageStatus } = await import('../usageRemote.mjs');
    const result = await fetchRemoteUsageStatus(['claudecode']);
    expect(result.authorized).toBe(false);
    expect(result.channels).toEqual([]);
    expect(result.errors?.[0]?.error).toBe('等待登录');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchAuthoritativeUsage returns ok:false without calling the server', async () => {
    const { fetchAuthoritativeUsage } = await import('../usageRemote.mjs');
    const result = await fetchAuthoritativeUsage();
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('等待登录');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchRemoteUsageStatus reads /report/usage/status with client+scene filters', async () => {
    await mkdir(path.join(tmpHome, 'auth'), { recursive: true });
    await writeFile(
      path.join(tmpHome, 'auth', 'openhermit.json'),
      JSON.stringify({ token: { accessToken: 'tok', expiresAt: '2999-01-01T00:00:00.000Z' } })
    );
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL = 'http://monitor.test';
    vi.resetModules();
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/me')) {
        return Response.json({ authenticated: true, status: 'ok', feishu_authorized: true });
      }
      if (u.includes('/api/v1/report/usage/status')) {
        const parsed = new URL(u);
        const client = parsed.searchParams.get('client');
        const scene = parsed.searchParams.get('scene');
        return Response.json({
          checkedAt: '2026-06-28T00:00:00.000Z',
          channels: [
            {
              reporter: 'agentcli',
              client,
              scene,
              status: 'success',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: {
                targetCursorHash: `${client}-${scene}`,
                messageCount: 3,
                fileCount: 1,
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const { fetchRemoteUsageStatus } = await import('../usageRemote.mjs');
    const result = await fetchRemoteUsageStatus(['claudecode']);

    // 新协议下 IM 归属是每条消息的 im 块，不再是独立 scene/mode 维度；本机只上报
    // scene=coding，故每个 provider 只查一次 coding（不再查 digital_employee）。
    expect(result.errors).toEqual([]);
    expect(result.channels).toHaveLength(1);
    expect(result.channels.every((c) => c.mode === undefined)).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      'http://monitor.test/api/v1/report/usage/status?client=claudecode&scene=coding'
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('scene=digital_employee'))
    ).toBe(false);
    expect(result.channels.map((c) => c.cursorHash)).toEqual(['claudecode-coding']);
  });

  // Node undici throws `TypeError('fetch failed')` whose real reason lives on
  // `err.cause` (ECONNRESET / UND_ERR_CONNECT_TIMEOUT / ...). The CLI must
  // surface that code so the panel doesn't just read a meaningless "fetch failed".
  const networkError = () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'socket hang up' },
    });

  it('fetchRemoteUsageStatus surfaces fetch err.cause code, not bare "fetch failed"', async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/me')) {
        return Response.json({ authenticated: true, status: 'ok', feishu_authorized: true });
      }
      if (u.includes('/api/v1/report/usage/status')) throw networkError();
      throw new Error(`unexpected fetch ${u}`);
    });

    const { fetchRemoteUsageStatus } = await import('../usageRemote.mjs');
    const result = await fetchRemoteUsageStatus(['claudecode']);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toMatch(/ECONNRESET/);
    expect(result.errors[0].error).toMatch(/fetch failed/);
  });

  it('fetchAuthoritativeUsage surfaces fetch err.cause code', async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/me')) {
        return Response.json({ authenticated: true, status: 'ok', feishu_authorized: true });
      }
      if (u.endsWith('/api/v1/report/usage')) throw networkError();
      throw new Error(`unexpected fetch ${u}`);
    });

    const { fetchAuthoritativeUsage } = await import('../usageRemote.mjs');
    const result = await fetchAuthoritativeUsage();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNRESET/);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendLarkCredentialsAuditLog,
  createInterruptibleWait,
  getLarkCredentialsWorkerPaths,
  resolveLarkCloudBaseUrl,
  runStartupOnce,
  scanLarkCredentialsOnce,
} from './worker';

describe('Lark credential loop', () => {
  let hermitHome: string | undefined;
  let previousPath: string | undefined;
  let previousCredentialExport: string | undefined;

  beforeEach(() => {
    // Credential discovery shells out to the REAL lark-cli binary; on a dev
    // machine that has one (plus real granted profiles) scans would refresh
    // live tokens against the production Feishu API and blow test timeouts.
    // Scrub PATH so discovery finds no binary and takes the fast path.
    previousPath = process.env.PATH;
    previousCredentialExport = process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT;
    process.env.PATH = '';
    process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT = '1';
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCredentialExport === undefined)
      delete process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT;
    else process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT = previousCredentialExport;
    if (hermitHome) await rm(hermitHome, { recursive: true, force: true });
    hermitHome = undefined;
  });

  it('appends a redacted, non-sensitive audit entry', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-audit-'));
    await appendLarkCredentialsAuditLog(hermitHome, {
      ok: false,
      enabled: true,
      reason: 'http-error',
      message: 'Bearer never-write-this secret=also-never-write-this',
      lastAttemptAt: '2026-07-15T00:00:00.000Z',
      lastErrorAt: '2026-07-15T00:00:00.000Z',
      lastHttpStatus: 503,
      accountCount: 1,
      accounts: [
        {
          appId: 'cli_app',
          userOpenId: 'ou_safe_identity',
          scope: 'contact:user.base:readonly',
          accessTokenExpiresAt: 1,
          refreshTokenExpiresAt: 2,
        },
      ],
    });

    const raw = await readFile(getLarkCredentialsWorkerPaths(hermitHome).auditLogPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      timestamp: '2026-07-15T00:00:00.000Z',
      ok: false,
      reason: 'http-error',
      httpStatus: 503,
      accountCount: 1,
      accounts: [
        {
          appId: 'cli_app',
          userOpenId: 'ou_safe_identity',
          scope: 'contact:user.base:readonly',
          accessTokenExpiresAt: 1,
          refreshTokenExpiresAt: 2,
        },
      ],
    });
    expect(raw).not.toContain('never-write-this');
    expect(raw).not.toContain('also-never-write-this');
  });
  it('resolves the Lark report base from the configured cloud settings', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-base-'));
    await writeFile(
      path.join(hermitHome, 'settings.json'),
      JSON.stringify({ cloud: { baseUrl: 'https://configured.example.test/' } })
    );

    await expect(resolveLarkCloudBaseUrl(hermitHome)).resolves.toBe(
      'https://configured.example.test'
    );
  });

  it('prefers the explicit upload override over saved cloud settings', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-base-env-'));
    await writeFile(
      path.join(hermitHome, 'settings.json'),
      JSON.stringify({ cloud: { baseUrl: 'https://configured.example.test' } })
    );
    const previous = process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = 'https://override.example.test/';
    try {
      await expect(resolveLarkCloudBaseUrl(hermitHome)).resolves.toBe(
        'https://override.example.test'
      );
    } finally {
      if (previous === undefined) delete process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
      else process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = previous;
    }
  });

  it('interrupts the worker scheduler wait immediately', async () => {
    const wait = createInterruptibleWait();
    const completion = wait.wait(5 * 60 * 1000);
    wait.interrupt();
    await expect(completion).resolves.toBeUndefined();
  });

  it('preserves the previous attempt while entering reporting state', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-preserve-'));
    const previous = process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = 'http://127.0.0.1:1';
    try {
      await scanLarkCredentialsOnce(hermitHome);
      const first = JSON.parse(
        await readFile(getLarkCredentialsWorkerPaths(hermitHome).statusPath, 'utf-8')
      );
      expect(first.lastAttempt).toBeTruthy();
      expect(first.report).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
      else process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = previous;
    }
  }, 30_000);

  it('continues credential reporting when status persistence is unavailable', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-readonly-'));
    await writeFile(path.join(hermitHome, 'lark-credentials'), 'not-a-directory');
    const previous = process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = 'http://127.0.0.1:1';
    try {
      await expect(scanLarkCredentialsOnce(hermitHome)).resolves.toMatchObject({ ok: false });
    } finally {
      if (previous === undefined) delete process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
      else process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = previous;
    }
  }, 30_000);

  it('writes an isolated, redacted Lark status when reporting cannot authenticate', async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-lark-worker-'));
    const previous = process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = 'http://127.0.0.1:1';
    try {
      const status = await scanLarkCredentialsOnce(hermitHome);
      expect(status.ok).toBe(false);
      const raw = await readFile(getLarkCredentialsWorkerPaths(hermitHome).statusPath, 'utf-8');
      expect(JSON.parse(raw)).toMatchObject({ pid: process.pid, report: { ok: false } });
      expect(raw).not.toContain('Bearer ');
    } finally {
      if (previous === undefined) delete process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
      else process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = previous;
    }
  });

  it('startup pass starts usage and Lark concurrently and returns both redacted results', async () => {
    const calls: string[] = [];
    let releaseUsage: (() => void) | undefined;
    let releaseLark: (() => void) | undefined;
    const usagePending = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const larkPending = new Promise<void>((resolve) => {
      releaseLark = resolve;
    });
    const usageStatus = {
      schemaVersion: 1 as const,
      state: 'idle' as const,
      running: true,
      pid: process.pid,
      startedAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      lastScan: '2026-07-16T00:00:00.000Z',
      source: 'local-jsonl' as const,
      telemetryEnabled: true,
      telemetry: {
        connected: false,
        lastScan: null,
        sessions: 0,
        messages: 0,
        imMessages: 0,
        imTokensTotal: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        totalTokens: 0,
        recentMessages: 0,
        recentTokensTotal: 0,
        recentByProvider: {
          claudecode: {
            sessions: 0,
            messages: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            tokensTotal: 0,
          },
          codex: {
            sessions: 0,
            messages: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            tokensTotal: 0,
          },
        },
        activeDays: 0,
        hourly: Array.from({ length: 24 }, () => 0),
        projects: [],
        workSecondsByDay: {},
        daily: {},
        localUsers: [],
        byProvider: {
          claudecode: {
            sessions: 0,
            messages: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            tokensTotal: 0,
          },
          codex: {
            sessions: 0,
            messages: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            tokensTotal: 0,
          },
        },
        unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
      },
    };
    const startup = runStartupOnce('/unused', {
      scanUsage: async () => {
        calls.push('usage');
        await usagePending;
        return { status: usageStatus, shouldContinue: true };
      },
      scanLark: async () => {
        calls.push('lark');
        await larkPending;
        return {
          ok: true,
          enabled: true,
          lastAttemptAt: '2026-07-16T00:00:00.000Z',
          lastSuccessAt: '2026-07-16T00:00:00.000Z',
          accountCount: 1,
        };
      },
    });

    expect(calls).toEqual(['usage', 'lark']);
    releaseLark?.();
    releaseUsage?.();
    const result = await startup;
    expect(result.ok).toBe(true);
    expect(result.usage.shouldContinue).toBe(true);
    expect(result.lark.accountCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Bearer ');
  });
});

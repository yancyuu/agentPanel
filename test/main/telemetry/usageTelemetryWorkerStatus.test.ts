import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scanTelemetryOnceMock = vi.hoisted(() => vi.fn());
vi.mock('@main/services/session-intelligence/UsageTelemetryService', () => ({
  scanTelemetryOnce: scanTelemetryOnceMock,
}));

import {
  emptyUsageTelemetryStatus,
  getLarkCredentialsWorkerPaths,
  getUsageTelemetryWorkerPaths,
  scanLarkCredentialsOnce,
  scanUsageTelemetryWorkerOnce,
} from '@main/telemetry/worker';

describe('usage telemetry worker status snapshots', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'hermit-worker-status-'));
    scanTelemetryOnceMock.mockReset();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('keeps the last persisted local telemetry while a new scan is in progress', async () => {
    const paths = getUsageTelemetryWorkerPaths(home);
    const previousTelemetry = {
      ...emptyUsageTelemetryStatus(),
      lastScan: '2026-06-28T03:00:00.000Z',
      sessions: 12,
      messages: 345,
      totalTokens: 6789,
    };
    await mkdir(paths.telemetryDir, { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ taskBus: { telemetry: { enabled: true } } })
    );
    await writeFile(
      paths.statusPath,
      JSON.stringify({
        schemaVersion: 1,
        state: 'idle',
        running: true,
        pid: 123,
        startedAt: '2026-06-28T02:55:00.000Z',
        updatedAt: '2026-06-28T03:00:00.000Z',
        lastScan: previousTelemetry.lastScan,
        source: 'claude-jsonl',
        telemetryEnabled: true,
        telemetry: previousTelemetry,
      })
    );

    let scanningTelemetry: unknown = null;
    const nextTelemetry = {
      ...emptyUsageTelemetryStatus(),
      lastScan: '2026-06-28T03:05:00.000Z',
      sessions: 13,
      messages: 400,
      totalTokens: 8000,
    };
    scanTelemetryOnceMock.mockImplementation(async () => {
      const scanningStatus = JSON.parse(await readFile(paths.statusPath, 'utf-8'));
      scanningTelemetry = scanningStatus.telemetry;
      return nextTelemetry;
    });

    const result = await scanUsageTelemetryWorkerOnce(home);

    expect(scanningTelemetry).toMatchObject({
      sessions: 12,
      messages: 345,
      totalTokens: 6789,
    });
    expect(result.status.telemetry).toMatchObject({
      sessions: 13,
      messages: 400,
      totalTokens: 8000,
    });
  });

  it('keeps the worker eligible for its independent Lark loop when message usage upload fails', async () => {
    const paths = getUsageTelemetryWorkerPaths(home);
    await mkdir(paths.telemetryDir, { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ taskBus: { telemetry: { enabled: true } } })
    );
    scanTelemetryOnceMock.mockRejectedValue(new Error('upload /api/v1/report/messages HTTP 422'));

    const result = await scanUsageTelemetryWorkerOnce(home);

    expect(result.shouldContinue).toBe(true);
    expect(result.status).toMatchObject({ state: 'error', running: true });
    expect(result.status.lastError).toContain('HTTP 422');
  });

  it('keeps Lark reporting out of the usage status snapshot', async () => {
    const paths = getUsageTelemetryWorkerPaths(home);
    await mkdir(paths.telemetryDir, { recursive: true });
    await writeFile(
      paths.settingsPath,
      JSON.stringify({ taskBus: { telemetry: { enabled: true } } })
    );
    scanTelemetryOnceMock.mockResolvedValue({
      ...emptyUsageTelemetryStatus(),
      lastScan: '2026-06-28T03:05:00.000Z',
    });

    const result = await scanUsageTelemetryWorkerOnce(home);

    expect(result.status).not.toHaveProperty('larkCredentials');
    expect(JSON.parse(await readFile(paths.statusPath, 'utf-8'))).not.toHaveProperty(
      'larkCredentials'
    );
  });

  it('writes Lark reporting status independently of usage telemetry status', async () => {
    const larkPaths = getLarkCredentialsWorkerPaths(home);
    const previous = process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
    const previousPath = process.env.PATH;
    const previousCredentialExport = process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT;
    process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = 'http://127.0.0.1:1';
    process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT = '1';
    // Credential discovery shells out to the REAL lark-cli binary; on a dev
    // machine that has one (plus real granted profiles) the scan would refresh
    // live tokens against the production Feishu API and blow the test timeout.
    // Scrub PATH so discovery finds no binary and takes the fast no-credentials
    // path — this test only cares about status persistence, not the network.
    process.env.PATH = '';
    try {
      const result = await scanLarkCredentialsOnce(home);
      expect(result.ok).toBe(false);
      const status = JSON.parse(await readFile(larkPaths.statusPath, 'utf-8'));
      expect(status.report).toMatchObject({ ok: false });
    } finally {
      if (previous === undefined) delete process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL;
      else process.env.OPENHERMIT_CLOUD_UPLOAD_BASE_URL = previous;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCredentialExport === undefined) delete process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT;
      else process.env.AGENTCLI_ENABLE_LARK_CREDENTIAL_EXPORT = previousCredentialExport;
    }
  });

});

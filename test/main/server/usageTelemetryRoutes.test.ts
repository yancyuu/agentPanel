import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryStatusShape } from '../../../src/main/routes/usageTelemetryPresenter';
import {
  registerUsageTelemetryRoutes,
  registerUsageTelemetryStatusRoutes,
} from '../../../src/main/routes/usageTelemetryRoutes';
import type { UsageTelemetryStatus } from '../../../src/main/services/session-intelligence/usageTypes';

const apps: ReturnType<typeof Fastify>[] = [];

type Dependencies = Parameters<typeof registerUsageTelemetryRoutes>[1];

function baseStatus(overrides: Partial<TelemetryStatusShape> = {}): TelemetryStatusShape {
  return {
    connected: false,
    lastScan: null,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    activeDays: 0,
    hourly: [],
    projects: [],
    workSecondsByDay: {},
    ...overrides,
  };
}

function createHarness(overrides: Partial<Dependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const runtimeStatus = {
    running: false,
    phase: 'idle' as const,
    startedAt: null,
    updatedAt: null,
    lastError: null,
  };
  const emptyStatus = baseStatus({ scan: runtimeStatus, worker: { running: false } });
  const presenter = {
    enrich: vi.fn((status: TelemetryStatusShape) => Promise.resolve({ ...status, enriched: true })),
    emptyStatus: vi.fn(() => ({ ...emptyStatus })),
    workerSummary: vi.fn(() => ({ running: true, state: 'idle', pid: 42 })),
    buildExport: vi.fn((status: TelemetryStatusShape, format: 'csv' | 'json') => ({
      filename: `usage.${format}`,
      mimeType: format,
      content: JSON.stringify(status),
    })),
    getRuntimeStatus: vi.fn(() => runtimeStatus),
  } satisfies Dependencies['presenter'];
  const dependencies: Dependencies = {
    presenter,
    readTaskBusSettings: vi.fn(() =>
      Promise.resolve({
        enabled: true,
        telemetry: { enabled: true, platform: 'claudecode' as const },
      })
    ),
    triggerScan: vi.fn(() => Promise.resolve(baseStatus({ sessions: 2 }) as UsageTelemetryStatus)),
    getTelemetryStatus: vi.fn(() =>
      Promise.resolve(baseStatus({ sessions: 3 }) as UsageTelemetryStatus)
    ),
    readWorkerStatus: vi.fn(() => Promise.resolve({ status: null })),
    ...overrides,
  };
  registerUsageTelemetryRoutes(app, dependencies);
  registerUsageTelemetryStatusRoutes(app, dependencies);
  return { app, dependencies, presenter, runtimeStatus, emptyStatus };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('usage telemetry routes', () => {
  it('rejects disabled telemetry and a failed scan with the existing status codes', async () => {
    const disabled = createHarness({
      readTaskBusSettings: vi.fn(() =>
        Promise.resolve({
          enabled: false,
          telemetry: { enabled: false, platform: 'claudecode' as const },
        })
      ),
    });
    const disabledResponse = await disabled.app.inject({
      method: 'POST',
      url: '/api/telemetry/scan',
    });

    const failed = createHarness({ triggerScan: vi.fn(() => Promise.resolve(null)) });
    const failedResponse = await failed.app.inject({ method: 'POST', url: '/api/telemetry/scan' });

    expect(disabledResponse.statusCode).toBe(400);
    expect(disabledResponse.json()).toEqual({ error: 'Telemetry is not enabled' });
    expect(disabled.dependencies.triggerScan).not.toHaveBeenCalled();
    expect(failedResponse.statusCode).toBe(503);
    expect(failedResponse.json()).toEqual({ error: 'Telemetry scan failed' });
  });

  it('enriches a successful scan with runtime and worker status', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({ method: 'POST', url: '/api/telemetry/scan' });

    expect(response.statusCode).toBe(200);
    expect(harness.presenter.enrich).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: 2,
        ok: true,
        scan: harness.runtimeStatus,
        worker: { running: true, state: 'idle', pid: 42 },
      })
    );
  });

  it('preserves JSON allowlisting, CSV defaulting, and export 500 errors', async () => {
    const harness = createHarness();

    const json = await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/export?format=json',
    });
    const csv = await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/export?format=xml',
    });

    expect(json.json()).toEqual(expect.objectContaining({ filename: 'usage.json' }));
    expect(csv.json()).toEqual(expect.objectContaining({ filename: 'usage.csv' }));
    expect(harness.presenter.buildExport).toHaveBeenNthCalledWith(1, expect.anything(), 'json');
    expect(harness.presenter.buildExport).toHaveBeenNthCalledWith(2, expect.anything(), 'csv');

    const failed = createHarness({
      getTelemetryStatus: vi.fn(() => Promise.reject(new Error('status failed'))),
    });
    const failedResponse = await failed.app.inject({ method: 'GET', url: '/api/telemetry/export' });
    expect(failedResponse.statusCode).toBe(500);
    expect(failedResponse.json()).toEqual({ error: 'Error: status failed' });
  });

  it('uses worker telemetry for status and overwrites connection, runtime, and worker fields', async () => {
    const workerTelemetry = baseStatus({ sessions: 9 });
    const harness = createHarness({
      readWorkerStatus: vi.fn(() =>
        Promise.resolve({
          status: {
            schemaVersion: 1 as const,
            state: 'idle' as const,
            running: true,
            pid: 42,
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:01:00.000Z',
            lastScan: '2026-01-01T00:01:00.000Z',
            source: 'claude-jsonl' as const,
            telemetryEnabled: true,
            telemetry: workerTelemetry as UsageTelemetryStatus,
          },
        })
      ),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/telemetry/status' });

    expect(response.statusCode).toBe(200);
    expect(harness.dependencies.getTelemetryStatus).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        sessions: 9,
        connected: true,
        scan: harness.runtimeStatus,
        worker: { running: true, state: 'idle', pid: 42 },
      })
    );
  });

  it('falls back to local or empty status and degrades route failures to an empty response', async () => {
    const local = createHarness();
    const localResponse = await local.app.inject({ method: 'GET', url: '/api/telemetry/status' });
    expect(localResponse.json()).toEqual(expect.objectContaining({ sessions: 3, connected: true }));

    const empty = createHarness({ getTelemetryStatus: vi.fn(() => Promise.resolve(null)) });
    const emptyResponse = await empty.app.inject({ method: 'GET', url: '/api/telemetry/status' });
    expect(empty.presenter.emptyStatus).toHaveBeenCalled();
    expect(emptyResponse.json()).toEqual(expect.objectContaining({ connected: true }));

    const degraded = createHarness({
      readWorkerStatus: vi.fn(() => Promise.reject(new Error('worker unreadable'))),
    });
    const degradedResponse = await degraded.app.inject({
      method: 'GET',
      url: '/api/telemetry/status',
    });
    expect(degradedResponse.statusCode).toBe(200);
    expect(degradedResponse.json()).toEqual(degraded.emptyStatus);
  });
});

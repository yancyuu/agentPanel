import fs from 'node:fs/promises';

import type { UsageTelemetryStatus } from '../services/session-intelligence/usageTypes';
import type {
  TelemetryStatusShape,
  UsageTelemetryPresenter,
  UsageTelemetryWorkerReadResult,
} from './usageTelemetryPresenter';
import type { TelemetryConfig } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

export async function readTaskBusSettingsFromFile(settingsFile: string): Promise<TelemetryConfig> {
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No settings.
  }
  return (settings.taskBus ?? {}) as TelemetryConfig;
}

interface UsageTelemetryRouteDependencies {
  presenter: UsageTelemetryPresenter;
  readTaskBusSettings: () => Promise<TelemetryConfig>;
  triggerScan: (config: TelemetryConfig) => Promise<UsageTelemetryStatus | null>;
  getTelemetryStatus: () => Promise<UsageTelemetryStatus | null>;
  readWorkerStatus: () => Promise<UsageTelemetryWorkerReadResult>;
}

export function registerUsageTelemetryRoutes(
  app: FastifyInstance,
  dependencies: UsageTelemetryRouteDependencies
): void {
  const { presenter, readTaskBusSettings, triggerScan, getTelemetryStatus, readWorkerStatus } =
    dependencies;

  app.post('/api/telemetry/scan', async (_request, reply) => {
    try {
      const taskBus = await readTaskBusSettings();
      if (!taskBus.telemetry?.enabled) {
        return reply.code(400).send({ error: 'Telemetry is not enabled' });
      }
      const result = await triggerScan(taskBus);
      if (!result) {
        return reply.code(503).send({ error: 'Telemetry scan failed' });
      }
      const workerStatus = await readWorkerStatus();
      return await presenter.enrich({
        ...result,
        ok: true,
        scan: presenter.getRuntimeStatus(),
        worker: presenter.workerSummary(workerStatus),
      });
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  app.get<{ Querystring: { format?: string } }>('/api/telemetry/export', async (request, reply) => {
    try {
      const format = request.query.format === 'json' ? 'json' : 'csv';
      const status = await presenter.enrich(
        ((await getTelemetryStatus()) as TelemetryStatusShape | null) ?? presenter.emptyStatus()
      );
      return presenter.buildExport(status, format);
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });
}

export function registerUsageTelemetryStatusRoutes(
  app: FastifyInstance,
  { presenter, getTelemetryStatus, readWorkerStatus }: UsageTelemetryRouteDependencies
): void {
  app.get('/api/telemetry/status', async () => {
    try {
      const workerStatus = await readWorkerStatus();
      const status = await presenter.enrich(
        (workerStatus.status?.telemetry as TelemetryStatusShape | undefined) ??
          ((await getTelemetryStatus()) as TelemetryStatusShape | null) ??
          presenter.emptyStatus()
      );
      status.connected = true;
      status.scan = presenter.getRuntimeStatus();
      status.worker = presenter.workerSummary(workerStatus);
      return status;
    } catch {
      return presenter.emptyStatus();
    }
  });
}

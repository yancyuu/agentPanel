import fs from 'node:fs/promises';
import path from 'node:path';

import type { HermitBridgeClient } from '../services/hermitBridge/HermitBridgeClient';
import type { TeamProvisioningService } from '../services/team-management';
import type { TelemetryConfig } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

type TaskBusBridgeClient = Pick<HermitBridgeClient, 'listProjects' | 'getProject'>;
type TaskBusTeamProvisioning = Pick<
  TeamProvisioningService,
  'readTeamManifest' | 'injectTeamInstructions' | 'removeTeamInstructions'
>;

interface TaskBusSettingsRouteDependencies {
  settingsFile: string;
  bridgeClient: TaskBusBridgeClient;
  teamProvisioning: TaskBusTeamProvisioning;
  isExternalTelemetryWorkerRunning(): Promise<boolean>;
  startTelemetry(config: TelemetryConfig): Promise<unknown>;
  stopTelemetry(): Promise<unknown>;
}

const DEFAULT_TASK_BUS_SETTINGS = {
  enabled: false,
  telemetry: { enabled: false, platform: 'claudecode' },
};

export function registerTaskBusSettingsRoutes(
  app: FastifyInstance,
  {
    settingsFile,
    bridgeClient,
    teamProvisioning,
    isExternalTelemetryWorkerRunning,
    startTelemetry,
    stopTelemetry,
  }: TaskBusSettingsRouteDependencies
): void {
  app.get('/api/settings/task-bus', async () => {
    try {
      const raw = await fs.readFile(settingsFile, 'utf8');
      const settings = JSON.parse(raw);
      return settings.taskBus ?? DEFAULT_TASK_BUS_SETTINGS;
    } catch {
      return DEFAULT_TASK_BUS_SETTINGS;
    }
  });

  app.put<{ Body: TelemetryConfig }>('/api/settings/task-bus', async (request) => {
    const config =
      request.body && 'taskBus' in (request.body as unknown as Record<string, unknown>)
        ? (request.body as unknown as { taskBus: TelemetryConfig }).taskBus
        : request.body;
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsFile, 'utf8');
      settings = JSON.parse(raw);
    } catch {
      // File doesn't exist yet.
    }
    settings.taskBus = config;
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));

    if (config.telemetry?.enabled) {
      if (await isExternalTelemetryWorkerRunning()) {
        await stopTelemetry();
      } else {
        await startTelemetry(config);
      }
    } else {
      await stopTelemetry();
    }

    const syncTeamInstructions = async (enabled: boolean): Promise<void> => {
      const projects = await bridgeClient.listProjects();
      for (const project of projects) {
        let workDir = '';
        let slug = project.name;
        try {
          const meta = await teamProvisioning.readTeamManifest(project.name);
          if (typeof meta.workDir === 'string') workDir = meta.workDir.trim();
          if (meta.slug) slug = meta.slug;
        } catch {
          // No local manifest.
        }
        if (!workDir) {
          try {
            const detail = await bridgeClient.getProject(project.name);
            if (typeof detail.work_dir === 'string') workDir = detail.work_dir.trim();
          } catch {
            // Ignore projects without a resolvable work directory.
          }
        }
        if (!workDir) continue;
        if (enabled) {
          await teamProvisioning.injectTeamInstructions(workDir, slug);
        } else {
          await teamProvisioning.removeTeamInstructions(workDir);
        }
      }
    };

    try {
      await syncTeamInstructions(config?.collaboration === true);
    } catch (error) {
      request.log.warn({ err: error }, 'CLAUDE.md team instruction sync failed');
    }

    return { ok: true, connected: false, message: '设置已保存' };
  });
}

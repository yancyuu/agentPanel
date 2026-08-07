import { readJsonObjectFile, updateJsonObjectFile } from '@main/utils/jsonSettingsFile';

import type { FastifyInstance } from 'fastify';

type ExternalChannelRuntimeState =
  | 'disabled'
  | 'restart-required'
  | 'starting'
  | 'running'
  | 'offline';

interface RuntimeSnapshot {
  status: 'disabled' | 'ok' | 'degraded';
  bridgeLaunch?: { status: 'disabled' | 'starting' | 'running' | 'offline' };
}

export interface ExternalChannelStatus {
  ccConnect: {
    enabled: boolean;
    active: boolean;
    restartRequired: boolean;
    state: ExternalChannelRuntimeState;
  };
}

function readCcConnectEnabled(settings: Record<string, unknown>): boolean {
  const externalChannels = settings.externalChannels;
  if (
    !externalChannels ||
    typeof externalChannels !== 'object' ||
    Array.isArray(externalChannels)
  ) {
    return false;
  }
  const ccConnect = (externalChannels as Record<string, unknown>).ccConnect;
  return Boolean(
    ccConnect &&
    typeof ccConnect === 'object' &&
    !Array.isArray(ccConnect) &&
    (ccConnect as Record<string, unknown>).enabled === true
  );
}

function createStatus({
  enabled,
  enabledAtStartup,
  runtime,
}: {
  enabled: boolean;
  enabledAtStartup: boolean;
  runtime: RuntimeSnapshot;
}): ExternalChannelStatus {
  const restartRequired = enabled !== enabledAtStartup;
  if (restartRequired) {
    return {
      ccConnect: { enabled, active: false, restartRequired: true, state: 'restart-required' },
    };
  }
  if (!enabled) {
    return {
      ccConnect: { enabled: false, active: false, restartRequired: false, state: 'disabled' },
    };
  }
  if (runtime.bridgeLaunch?.status === 'running' || runtime.status === 'ok') {
    return { ccConnect: { enabled: true, active: true, restartRequired: false, state: 'running' } };
  }
  if (runtime.bridgeLaunch?.status === 'starting' || runtime.status === 'disabled') {
    return {
      ccConnect: { enabled: true, active: false, restartRequired: false, state: 'starting' },
    };
  }
  return { ccConnect: { enabled: true, active: false, restartRequired: false, state: 'offline' } };
}

/**
 * Persist and report the optional cc-connect channel lifecycle. A process is
 * deliberately configured only at boot, so a changed preference is explicitly
 * reported as pending rather than pretending that an in-process bridge restart
 * activated/deactivated the plugin.
 */
export function registerExternalChannelRoutes(
  app: FastifyInstance,
  {
    settingsFile,
    enabledAtStartup = false,
    getRuntimeStatus = () => ({ status: 'disabled' as const }),
  }: {
    settingsFile: string;
    enabledAtStartup?: boolean;
    getRuntimeStatus?: () => RuntimeSnapshot;
  }
): void {
  app.get('/api/external-channels', async (): Promise<ExternalChannelStatus> => {
    const settings = await readJsonObjectFile(settingsFile);
    return createStatus({
      enabled: readCcConnectEnabled(settings),
      enabledAtStartup,
      runtime: getRuntimeStatus(),
    });
  });

  app.put<{ Body: { enabled?: unknown } }>(
    '/api/external-channels/cc-connect',
    async (request, reply) => {
      if (typeof request.body?.enabled !== 'boolean') {
        return reply.code(400).send({ ok: false, error: 'enabled 必须是布尔值' });
      }
      const enabled = request.body.enabled;
      await updateJsonObjectFile(settingsFile, (settings) => {
        const existingChannels = settings.externalChannels;
        const externalChannels =
          existingChannels &&
          typeof existingChannels === 'object' &&
          !Array.isArray(existingChannels)
            ? { ...(existingChannels as Record<string, unknown>) }
            : {};
        externalChannels.ccConnect = { enabled };
        settings.externalChannels = externalChannels;
      });
      return {
        ok: true,
        data: createStatus({ enabled, enabledAtStartup, runtime: getRuntimeStatus() }),
      };
    }
  );
}

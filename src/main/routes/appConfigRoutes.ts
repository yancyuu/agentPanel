import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export const DEFAULT_APP_CONFIG = {
  notifications: {
    enabled: true,
    soundEnabled: true,
    ignoredRegex: [] as string[],
    ignoredRepositories: [] as string[],
    snoozedUntil: null as number | null,
    snoozeMinutes: 30,
    includeSubagentErrors: false,
    notifyOnLeadInbox: false,
    notifyOnUserInbox: true,
    notifyOnClarifications: true,
    notifyOnStatusChange: true,
    notifyOnTaskDeliveries: true,
    notifyOnTaskCreated: true,
    notifyOnAllTasksCompleted: true,
    notifyOnCrossTeamMessage: true,
    notifyOnTeamLaunched: true,
    notifyOnToolApproval: true,
    autoResumeOnRateLimit: false,
    statusChangeOnlySolo: false,
    statusChangeStatuses: ['in_progress', 'completed'] as string[],
    triggers: [] as unknown[],
  },
  general: {
    launchAtLogin: false,
    showDockIcon: true,
    theme: 'dark' as 'dark' | 'light' | 'system',
    defaultTab: 'dashboard' as 'dashboard' | 'last-session',
    multimodelEnabled: false,
    claudeRootPath: null as string | null,
    agentLanguage: 'system',
    autoExpandAIGroups: false,
    useNativeTitleBar: false,
    telemetryEnabled: true,
  },
  providerConnections: {
    anthropic: {
      authMode: 'auto' as 'auto' | 'oauth' | 'api_key',
      fastModeDefault: false,
    },
    codex: {
      preferredAuthMode: 'auto' as 'auto' | 'chatgpt' | 'api_key',
    },
  },
  runtime: {
    providerBackends: {
      gemini: 'auto' as 'auto' | 'api' | 'cli-sdk',
      codex: 'codex-native' as const,
    },
  },
  display: {
    showTimestamps: true,
    compactMode: false,
    syntaxHighlighting: true,
  },
  sessions: {
    pinnedSessions: {} as Record<string, { sessionId: string; pinnedAt: number }[]>,
    hiddenSessions: {} as Record<string, { sessionId: string; hiddenAt: number }[]>,
  },
  claudeEnv: {} as Record<string, string>,
};

type AppConfig = typeof DEFAULT_APP_CONFIG;

interface AppConfigRouteDependencies {
  configFile: string;
  hermitHome: string;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigDefaults<T extends Record<string, unknown>>(defaults: T, value: unknown): T {
  if (!isPlainObject(value)) return defaults;

  const output: Record<string, unknown> = { ...defaults };
  for (const [key, entry] of Object.entries(value)) {
    const defaultEntry = output[key];
    output[key] = isPlainObject(defaultEntry) ? mergeConfigDefaults(defaultEntry, entry) : entry;
  }
  return output as T;
}

export function registerAppConfigRoutes(
  app: FastifyInstance,
  { configFile, hermitHome, logger }: AppConfigRouteDependencies
): void {
  const readAppConfig = (): AppConfig => {
    try {
      if (existsSync(configFile)) {
        const raw = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
        return mergeConfigDefaults(DEFAULT_APP_CONFIG, raw);
      }
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? `${configFile} 格式错误: ${error.message}。将使用默认配置并覆盖修复。`
          : `读取 ${configFile} 失败`;
      logger.warn({ err: error }, message);
      try {
        mkdirSync(hermitHome, { recursive: true });
        writeFileSync(configFile, JSON.stringify(DEFAULT_APP_CONFIG, null, 2), 'utf8');
      } catch {
        // Best-effort auto-heal; the default response remains available.
      }
    }
    return DEFAULT_APP_CONFIG;
  };

  const writeAppConfig = (config: AppConfig): AppConfig => {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
    return config;
  };

  app.get('/api/config', async () => ({
    success: true,
    data: readAppConfig(),
  }));

  app.post<{ Body: { section?: unknown; data?: unknown } }>(
    '/api/config/update',
    async (request) => {
      const section = typeof request.body?.section === 'string' ? request.body.section : '';
      const patch = isPlainObject(request.body?.data) ? request.body.data : {};
      const current = readAppConfig();
      const next = section
        ? mergeConfigDefaults(current, {
            [section]: {
              ...(isPlainObject((current as Record<string, unknown>)[section])
                ? ((current as Record<string, unknown>)[section] as Record<string, unknown>)
                : {}),
              ...patch,
            },
          })
        : current;
      return {
        success: true,
        data: writeAppConfig(next),
      };
    }
  );

  app.get('/api/config/triggers', async () => []);
}

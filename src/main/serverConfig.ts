import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

export interface HermitConfig {
  ccBaseUrl: string;
  ccToken: string;
  ccBridgeUrl: string;
  ccBridgeToken: string;
}

export interface ServerEnvironment {
  repoRoot: string;
  version: string;
  host: string;
  port: number;
  staticDir: string;
  hermitHome: string;
  hermitConfigFile: string;
  hermitAppConfigFile: string;
  hermitBridgeDir: string;
  legacyBridgeDir: string;
  hermitBridgeConfigFile: string;
  legacyBridgeConfigFile: string;
  hermitBridgeDataDir: string;
  legacyBridgeDataDir: string;
  hermitSettingsFile: string;
  /** Optional external-channel integration. Disabled unless explicitly enabled. */
  ccConnectEnabled: boolean;
  bridgeLogFile: string;
  bridgeAutoLaunchTimeoutMs: number;
  bridgeBaseUrl: string;
  bridgeWsUrl: string;
  allowedCorsOrigins: string[];
  desktopSessionToken: string;
  logLevel: string;
}

export interface HermitConfigStore {
  load: () => HermitConfig;
  save: (patch: Partial<HermitConfig>) => HermitConfig;
  readRaw: () => { path: string; content: string };
  writeRaw: (content: string) => HermitConfig;
  readBridgeRaw: () => { path: string; content: string };
  writeBridgeRaw: (content: string) => Promise<void>;
  readBridgeToken: (section: 'bridge' | 'management') => string;
}

function readPackageMetadata(packagePath: string): { name?: string; version?: string } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : undefined,
      version: typeof record.version === 'string' ? record.version : undefined,
    };
  } catch {
    return {};
  }
}

function assertSafeBridgeRawConfig(content: string): void {
  if (!content.trim()) throw new Error('cc-connect 配置不能为空');
  let section: 'management' | 'bridge' | null = null;
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = sourceLine.replace(/#.*$/u, '').trim();
    if (line === '[management]') {
      section = 'management';
      continue;
    }
    if (line === '[bridge]') {
      section = 'bridge';
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    if (!section) continue;
    const host = /^host\s*=\s*"([^"]*)"\s*$/u.exec(line)?.[1];
    if (host !== undefined && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw new Error(`${section} 服务只能绑定到本机回环地址`);
    }
    const port = /^port\s*=\s*(\d+)\s*$/u.exec(line)?.[1];
    if (port && (Number(port) < 1 || Number(port) > 65535)) {
      throw new Error(`${section} 端口必须在 1 到 65535 之间`);
    }
    const token = /^token\s*=\s*"([^"]*)"\s*$/u.exec(line)?.[1];
    if (token !== undefined && !token.trim()) throw new Error(`${section} token 不能为空`);
  }
}

function isCcConnectEnabled(settingsFile: string, env: NodeJS.ProcessEnv): boolean {
  if (env.AGENTPANEL_CC_CONNECT_ENABLED === '1') return true;
  if (env.AGENTPANEL_CC_CONNECT_ENABLED === '0') return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const externalChannels = (parsed as Record<string, unknown>).externalChannels;
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
  } catch {
    return false;
  }
}

export function findAgentPanelRoot(startDir: string): string {
  let directory = startDir;
  for (let index = 0; index < 12; index += 1) {
    try {
      if (
        readPackageMetadata(path.join(directory, 'package.json')).name === '@yancyyu/agentpanel'
      ) {
        return directory;
      }
    } catch {
      // Missing or malformed package.json — keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(startDir, '..', '..');
}

export function createServerEnvironment({
  startDir,
  env = process.env,
  homeDir = os.homedir(),
}: {
  startDir: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): ServerEnvironment {
  const repoRoot = findAgentPanelRoot(startDir);
  const version = readPackageMetadata(path.join(repoRoot, 'package.json')).version ?? '0.0.0';
  const host = env.HOST ?? '127.0.0.1';
  const port = Number.parseInt(env.PORT ?? '5680', 10);
  const staticDir = env.STATIC_DIR ?? path.resolve(repoRoot, 'dist-renderer');
  const hermitHome = env.HERMIT_HOME ?? path.join(homeDir, '.hermit');
  const hermitBridgeDir = path.join(hermitHome, 'cc-connect');
  const legacyBridgeDir = path.join(hermitHome, 'hermit-bridge');
  const hermitSettingsFile = path.join(hermitHome, 'settings.json');
  const ccConnectEnabled = isCcConnectEnabled(hermitSettingsFile, env);
  const hermitBridgeConfigFile = path.join(hermitBridgeDir, 'config.toml');
  const legacyBridgeConfigFile = path.join(legacyBridgeDir, 'config.toml');
  const hermitBridgeDataDir = path.join(hermitBridgeDir, 'data');
  const legacyBridgeDataDir = path.join(legacyBridgeDir, 'data');
  const parsedTimeout = Number.parseInt(env.HERMIT_BRIDGE_AUTO_LAUNCH_TIMEOUT_MS ?? '', 10);
  const bridgeAutoLaunchTimeoutMs = Number.isFinite(parsedTimeout)
    ? Math.max(30_000, parsedTimeout)
    : 180_000;
  const bridgeBaseUrl =
    env.HERMIT_BRIDGE_BASE_URL ?? env.CC_CONNECT_BASE_URL ?? 'http://127.0.0.1:9820';
  const bridgeWsUrl =
    env.HERMIT_BRIDGE_WS_URL ?? env.CC_CONNECT_BRIDGE_URL ?? 'ws://127.0.0.1:9810/bridge/ws';
  const configuredCorsOrigins = env.CORS_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const defaultWebPort = env.WEB_PORT?.trim() || '5174';
  const allowedCorsOrigins = configuredCorsOrigins?.length
    ? configuredCorsOrigins
    : [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://127.0.0.1:${defaultWebPort}`,
        `http://localhost:${defaultWebPort}`,
      ];

  return {
    repoRoot,
    version,
    host,
    port,
    staticDir,
    hermitHome,
    hermitConfigFile: path.join(hermitHome, 'config.json'),
    hermitAppConfigFile: path.join(hermitHome, 'app-config.json'),
    hermitBridgeDir,
    legacyBridgeDir,
    hermitBridgeConfigFile,
    legacyBridgeConfigFile,
    hermitBridgeDataDir,
    legacyBridgeDataDir,
    hermitSettingsFile,
    ccConnectEnabled,
    bridgeLogFile: path.join(hermitBridgeDir, 'cc-connect.log'),
    bridgeAutoLaunchTimeoutMs,
    bridgeBaseUrl,
    bridgeWsUrl,
    allowedCorsOrigins,
    desktopSessionToken: env.AGENTPANEL_DESKTOP_SESSION_TOKEN?.trim() ?? '',
    logLevel: env.HERMIT_LOG_LEVEL ?? 'warn',
  };
}

export function createHermitConfigStore(
  environment: ServerEnvironment,
  env: NodeJS.ProcessEnv = process.env
): HermitConfigStore {
  const normalizeMigratedBridgeConfig = (raw: string): string =>
    raw
      .split(environment.legacyBridgeDataDir)
      .join(environment.hermitBridgeDataDir)
      .split('~/.hermit/hermit-bridge/data')
      .join('~/.hermit/cc-connect/data');

  const migrateLegacyBridgeDataIfNeeded = (): boolean => {
    if (
      existsSync(environment.hermitBridgeDataDir) ||
      !existsSync(environment.legacyBridgeDataDir)
    ) {
      return false;
    }
    mkdirSync(path.dirname(environment.hermitBridgeDataDir), { recursive: true });
    try {
      renameSync(environment.legacyBridgeDataDir, environment.hermitBridgeDataDir);
    } catch {
      cpSync(environment.legacyBridgeDataDir, environment.hermitBridgeDataDir, {
        recursive: true,
      });
      rmSync(environment.legacyBridgeDataDir, { recursive: true, force: true });
    }
    return true;
  };

  const normalizeBridgeConfigFileIfNeeded = (): boolean => {
    if (!existsSync(environment.hermitBridgeConfigFile)) return false;
    const raw = readFileSync(environment.hermitBridgeConfigFile, 'utf8');
    const normalized = normalizeMigratedBridgeConfig(raw);
    if (normalized === raw) return false;
    writeFileSync(environment.hermitBridgeConfigFile, normalized, 'utf8');
    return true;
  };

  const migrateLegacyBridgeConfigIfNeeded = (): void => {
    const migratedData = migrateLegacyBridgeDataIfNeeded();
    let migratedConfig = false;
    if (
      !existsSync(environment.hermitBridgeConfigFile) &&
      existsSync(environment.legacyBridgeConfigFile)
    ) {
      mkdirSync(path.dirname(environment.hermitBridgeConfigFile), { recursive: true });
      const migrated = normalizeMigratedBridgeConfig(
        readFileSync(environment.legacyBridgeConfigFile, 'utf8')
      );
      writeFileSync(environment.hermitBridgeConfigFile, migrated, 'utf8');
      rmSync(environment.legacyBridgeConfigFile, { force: true });
      migratedConfig = true;
    }
    const normalizedConfig = normalizeBridgeConfigFileIfNeeded();
    if (migratedData || migratedConfig || normalizedConfig) {
      console.info('[AgentPanel] migrated runtime files to ~/.hermit/cc-connect/');
    }
  };

  const createStarterBridgeConfig = (): string => {
    const createToken = () => randomBytes(24).toString('hex');
    return `# cc-connect external-channel configuration\n# Created by AgentPanel only after the integration is explicitly enabled.\n\ndata_dir = "${environment.hermitBridgeDataDir.replaceAll('\\', '\\\\')}"\nlanguage = "zh"\n\n[management]\nenabled = true\nhost = "127.0.0.1"\nport = 9820\ntoken = "${createToken()}"\n\n[bridge]\nenabled = true\nhost = "127.0.0.1"\nport = 9810\ntoken = "${createToken()}"\npath = "/bridge/ws"\n\n[log]\nlevel = "info"\n`;
  };

  const ensureWritableBridgeConfigFile = (): string => {
    migrateLegacyBridgeConfigIfNeeded();
    if (existsSync(environment.hermitBridgeConfigFile)) {
      return environment.hermitBridgeConfigFile;
    }
    if (!environment.ccConnectEnabled) {
      throw new Error('cc-connect 外部渠道插件尚未启用');
    }
    mkdirSync(path.dirname(environment.hermitBridgeConfigFile), { recursive: true });
    mkdirSync(environment.hermitBridgeDataDir, { recursive: true });
    writeFileSync(environment.hermitBridgeConfigFile, createStarterBridgeConfig(), 'utf8');
    return environment.hermitBridgeConfigFile;
  };

  const readBridgeToken = (section: 'bridge' | 'management'): string => {
    try {
      const raw = readFileSync(ensureWritableBridgeConfigFile(), 'utf8');
      const match = new RegExp(`\\[${section}\\][^\\[]*token\\s*=\\s*"([^"]+)"`, 's').exec(raw);
      return match?.[1]?.trim() ?? '';
    } catch {
      return '';
    }
  };

  const load = (): HermitConfig => {
    // Direct local execution must not read, migrate, or mutate cc-connect TOML
    // merely because the optional external-channel integration is installed.
    const tomlManagementToken = environment.ccConnectEnabled ? readBridgeToken('management') : '';
    const tomlBridgeToken = environment.ccConnectEnabled ? readBridgeToken('bridge') : '';
    const defaults: HermitConfig = {
      ccBaseUrl: env.HERMIT_BRIDGE_BASE_URL ?? env.CC_CONNECT_BASE_URL ?? 'http://127.0.0.1:9820',
      ccToken:
        env.HERMIT_BRIDGE_TOKEN ||
        env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
        env.CC_CONNECT_TOKEN ||
        env.CC_CONNECT_MANAGEMENT_TOKEN ||
        tomlManagementToken,
      ccBridgeUrl:
        env.HERMIT_BRIDGE_WS_URL ?? env.CC_CONNECT_BRIDGE_URL ?? 'ws://127.0.0.1:9810/bridge/ws',
      ccBridgeToken:
        env.CC_CONNECT_BRIDGE_TOKEN ||
        tomlBridgeToken ||
        env.HERMIT_BRIDGE_TOKEN ||
        env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ||
        env.CC_CONNECT_TOKEN ||
        env.CC_CONNECT_MANAGEMENT_TOKEN ||
        tomlManagementToken,
    };
    let merged = { ...defaults };
    try {
      if (existsSync(environment.hermitConfigFile)) {
        const raw = JSON.parse(
          readFileSync(environment.hermitConfigFile, 'utf8')
        ) as Partial<HermitConfig>;
        merged = { ...defaults, ...raw };
      }
    } catch (error) {
      const message =
        error instanceof SyntaxError
          ? `${environment.hermitConfigFile} 格式错误: ${error.message}。将使用默认配置并覆盖修复。`
          : `读取 ${environment.hermitConfigFile} 失败: ${
              error instanceof Error ? error.message : String(error)
            }`;
      console.warn(`[AgentPanel] ${message}`);
      mkdirSync(environment.hermitHome, { recursive: true });
      writeFileSync(environment.hermitConfigFile, JSON.stringify(defaults, null, 2), 'utf8');
    }
    if (!merged.ccBridgeToken.trim()) {
      merged = { ...merged, ccBridgeToken: tomlBridgeToken || merged.ccToken };
    }
    return merged;
  };

  const save = (patch: Partial<HermitConfig>): HermitConfig => {
    const next = { ...load(), ...patch };
    mkdirSync(environment.hermitHome, { recursive: true });
    writeFileSync(environment.hermitConfigFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  };

  const readRaw = (): { path: string; content: string } => {
    if (existsSync(environment.hermitConfigFile)) {
      return {
        path: environment.hermitConfigFile,
        content: readFileSync(environment.hermitConfigFile, 'utf8'),
      };
    }
    return {
      path: environment.hermitConfigFile,
      content: `${JSON.stringify(load(), null, 2)}\n`,
    };
  };

  const writeRaw = (content: string): HermitConfig => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `配置文件 JSON 格式错误: ${error.message}。请检查是否有尾逗号、单引号或注释等非法 JSON 语法。`
        );
      }
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AgentPanel 配置必须是 JSON 对象');
    }
    mkdirSync(environment.hermitHome, { recursive: true });
    writeFileSync(
      environment.hermitConfigFile,
      content.endsWith('\n') ? content : `${content}\n`,
      'utf8'
    );
    return load();
  };

  return {
    load,
    save,
    readRaw,
    writeRaw,
    readBridgeRaw: () => {
      const configFile = ensureWritableBridgeConfigFile();
      return { path: configFile, content: readFileSync(configFile, 'utf8') };
    },
    writeBridgeRaw: (content) => {
      assertSafeBridgeRawConfig(content);
      return atomicWriteAsync(ensureWritableBridgeConfigFile(), content);
    },
    readBridgeToken,
  };
}

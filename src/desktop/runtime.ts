import path from 'node:path';

export const DESKTOP_TELEMETRY_RECONCILE_ARGS = ['usage', 'reconcile', '--json'] as const;

export interface DesktopRuntimePaths {
  appRoot: string;
  runtimeRoot: string;
  serverEntry: string;
  staticDir: string;
  cliEntry: string;
}

export function resolveDesktopRuntimePaths(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): DesktopRuntimePaths {
  const runtimeRoot = options.isPackaged
    ? path.join(options.resourcesPath, 'agentcli')
    : options.appPath;
  return {
    appRoot: options.appPath,
    runtimeRoot,
    serverEntry: path.join(runtimeRoot, 'dist', 'server.bundle.mjs'),
    staticDir: path.join(runtimeRoot, 'dist-renderer'),
    cliEntry: path.join(runtimeRoot, 'bin', 'agentcli.mjs'),
  };
}

export function buildDesktopServerEnvironment(options: {
  baseEnvironment?: NodeJS.ProcessEnv;
  port: number;
  sessionToken: string;
  staticDir: string;
  runtimeRoot: string;
  hermitHome: string;
}): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${options.port}`;
  const baseEnvironment = options.baseEnvironment ?? process.env;
  const managedBinDir = path.join(options.hermitHome, 'bin');
  const executablePath = [managedBinDir, baseEnvironment.PATH].filter(Boolean).join(path.delimiter);
  return {
    ...baseEnvironment,
    PATH: executablePath,
    ELECTRON_RUN_AS_NODE: '1',
    AGENTCLI_DESKTOP: '1',
    AGENTCLI_PACKAGED_DESKTOP: '1',
    AGENTCLI_DESKTOP_SESSION_TOKEN: options.sessionToken,
    AGENTCLI_PACKAGE_ROOT: options.runtimeRoot,
    HERMIT_DISABLE_TELEMETRY_AUTOSTART: '1',
    HOST: '127.0.0.1',
    PORT: String(options.port),
    STATIC_DIR: options.staticDir,
    HERMIT_HOME: options.hermitHome,
    CORS_ORIGIN: origin,
    HERMIT_WORKBENCH_URL: origin,
  };
}

export function isAllowedWorkbenchNavigation(targetUrl: string, workbenchOrigin: string): boolean {
  try {
    const target = new URL(targetUrl);
    return target.origin === workbenchOrigin;
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(targetUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    return target.protocol === 'https:' || target.protocol === 'http:';
  } catch {
    return false;
  }
}

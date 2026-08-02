import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, Menu, nativeTheme, session, shell } from 'electron';

import { writeAtomicFile } from '../shared/writeAtomic/index.mjs';
import { DESKTOP_RUNTIME_METADATA_FILE, DESKTOP_SESSION_HEADER } from '../shared/constants/desktop';

import {
  buildDesktopServerEnvironment,
  DESKTOP_TELEMETRY_RECONCILE_ARGS,
  isAllowedExternalUrl,
  isAllowedWorkbenchNavigation,
  resolveDesktopRuntimePaths,
} from './runtime';

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_RETRY_MS = 250;
const SERVER_START_ATTEMPTS = 3;
const SERVER_STOP_TIMEOUT_MS = 8_000;
const LOG_LINE_LIMIT = 80;

interface RunningServer {
  child: ChildProcess;
  origin: string;
  port: number;
  sessionToken: string;
  metadataFile: string;
  runtimeRoot: string;
  cliEntry: string;
  hermitHome: string;
  logs: string[];
}

let mainWindow: BrowserWindow | null = null;
let runningServer: RunningServer | null = null;
let bootPromise: Promise<void> | null = null;
let shutdownStarted = false;
let allowQuit = false;

function appendLog(target: string[], chunk: Buffer, sessionToken: string): void {
  const sanitized = chunk.toString('utf8').split(sessionToken).join('[redacted]');
  for (const line of sanitized.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    target.push(line.slice(0, 600));
  }
  if (target.length > LOG_LINE_LIMIT) target.splice(0, target.length - LOG_LINE_LIMIT);
}

async function chooseLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error('无法分配本地服务端口'));
      });
    });
  });
}

async function waitForHealth(server: RunningServer): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`本地服务提前退出（代码 ${server.child.exitCode}）`);
    }
    try {
      const response = await fetch(`${server.origin}/api/health`, {
        headers: { [DESKTOP_SESSION_HEADER]: server.sessionToken },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
  }
  throw new Error('本地服务启动超时');
}

async function writeRuntimeMetadata(server: RunningServer, runtimeRoot: string): Promise<void> {
  await writeAtomicFile(
    server.metadataFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pid: server.child.pid,
        origin: server.origin,
        port: server.port,
        sessionToken: server.sessionToken,
        runtimeRoot,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

async function removeOwnedRuntimeMetadata(server: RunningServer): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(server.metadataFile, 'utf8')) as {
      sessionToken?: string;
    };
    if (parsed.sessionToken === server.sessionToken) {
      await rm(server.metadataFile, { force: true });
    }
  } catch {
    // Missing or replaced metadata belongs to no longer-running/another process.
  }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server) return;
  await removeOwnedRuntimeMetadata(server);
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => server.child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, SERVER_STOP_TIMEOUT_MS)),
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function startServer(): Promise<RunningServer> {
  const paths = resolveDesktopRuntimePaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  await Promise.all([access(paths.serverEntry), access(paths.staticDir), access(paths.cliEntry)]);
  const hermitHome = path.join(os.homedir(), '.hermit');
  const metadataFile = path.join(hermitHome, DESKTOP_RUNTIME_METADATA_FILE);
  let lastError: unknown;

  for (let attempt = 0; attempt < SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await chooseLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const sessionToken = randomBytes(32).toString('hex');
    const logs: string[] = [];
    const child = spawn(process.execPath, [paths.serverEntry], {
      cwd: paths.runtimeRoot,
      env: buildDesktopServerEnvironment({
        port,
        sessionToken,
        staticDir: paths.staticDir,
        runtimeRoot: paths.runtimeRoot,
        hermitHome,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const server: RunningServer = {
      child,
      origin,
      port,
      sessionToken,
      metadataFile,
      runtimeRoot: paths.runtimeRoot,
      cliEntry: paths.cliEntry,
      hermitHome,
      logs,
    };
    child.stdout?.on('data', (chunk: Buffer) => appendLog(logs, chunk, sessionToken));
    child.stderr?.on('data', (chunk: Buffer) => appendLog(logs, chunk, sessionToken));
    try {
      await waitForHealth(server);
      await writeRuntimeMetadata(server, paths.runtimeRoot);
      return server;
    } catch (error) {
      lastError = error;
      await stopServer(server);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : '本地服务启动失败');
}

async function reconcileTelemetryOwnership(server: RunningServer): Promise<void> {
  if (!app.isPackaged) return;
  const managedBinDir = path.join(server.hermitHome, 'bin');
  const telemetryBootstrap = spawn(
    process.execPath,
    [server.cliEntry, ...DESKTOP_TELEMETRY_RECONCILE_ARGS],
    {
      cwd: server.runtimeRoot,
      env: {
        ...process.env,
        PATH: [managedBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        ELECTRON_RUN_AS_NODE: '1',
        AGENTCLI_PACKAGE_ROOT: server.runtimeRoot,
        HERMIT_HOME: server.hermitHome,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    }
  );
  await new Promise<number | null>((resolve) => {
    telemetryBootstrap.once('error', () => resolve(null));
    telemetryBootstrap.once('close', resolve);
  });
}

function installSessionSecurity(server: RunningServer): void {
  const desktopSession = session.fromPartition('persist:agentcli-desktop');
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: [`${server.origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [DESKTOP_SESSION_HEADER]: server.sessionToken,
        },
      });
    }
  );
}

function createWorkbenchWindow(server: RunningServer): BrowserWindow {
  const window = new BrowserWindow({
    title: 'AgentCLI',
    show: true,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f7f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:agentcli-desktop',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedWorkbenchNavigation(targetUrl, server.origin)) event.preventDefault();
  });
  void window.loadURL(`${server.origin}/`);
  return window;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function createFailureWindow(error: unknown, logs: string[]): BrowserWindow {
  const message = error instanceof Error ? error.message : String(error);
  const window = new BrowserWindow({
    title: 'AgentCLI 启动失败',
    width: 720,
    height: 520,
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#171719',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });
  const logText = logs.slice(-20).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentCLI 启动失败</title><style>body{margin:0;background:#171719;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.wrap{max-width:640px;margin:64px auto;padding:0 28px}h1{font-size:22px}p{color:#bbb;line-height:1.7}.actions{display:flex;gap:12px;margin:24px 0}a{display:inline-block;border-radius:8px;background:#4f46e5;color:white;padding:10px 16px;text-decoration:none}pre{max-height:220px;overflow:auto;border:1px solid #333;border-radius:8px;background:#101011;padding:12px;color:#aaa;font:11px ui-monospace,monospace;white-space:pre-wrap}</style><div class="wrap"><h1>客户端暂时无法启动</h1><p>${escapeHtml(message)}</p><p>请点击重试。如果仍然失败，可以退出后重新打开客户端。</p><div class="actions"><a href="agentcli://retry">重试</a><a href="agentcli://quit">退出</a></div>${logText ? `<pre>${escapeHtml(logText)}</pre>` : ''}</div></html>`;
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl === 'agentcli://retry') {
      event.preventDefault();
      window.once('closed', () => void bootDesktop());
      window.close();
    } else if (targetUrl === 'agentcli://quit') {
      event.preventDefault();
      app.quit();
    } else {
      event.preventDefault();
    }
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return window;
}

function trackMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

function usableMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return null;
  }
  return mainWindow;
}

async function bootDesktopOnce(): Promise<void> {
  if (usableMainWindow()) return;
  try {
    runningServer = await startServer();
    installSessionSecurity(runningServer);
    trackMainWindow(createWorkbenchWindow(runningServer));
    void reconcileTelemetryOwnership(runningServer);
  } catch (error) {
    console.error('[AgentCLI desktop] boot failed', error);
    const logs = runningServer?.logs ?? [];
    runningServer = null;
    try {
      trackMainWindow(createFailureWindow(error, logs));
    } catch (failureWindowError) {
      console.error('[AgentCLI desktop] failure window creation failed', failureWindowError);
    }
  }
}

function bootDesktop(): Promise<void> {
  bootPromise ??= bootDesktopOnce().finally(() => {
    bootPromise = null;
  });
  return bootPromise;
}

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const server = runningServer;
  runningServer = null;
  await stopServer(server);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = usableMainWindow();
    if (!window) {
      void bootDesktop();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void shutdown().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    const window = usableMainWindow();
    if (window) {
      window.show();
      return;
    }
    void bootDesktop();
  });

  void app.whenReady().then(async () => {
    // Keep the native title bar aligned with the default light workbench instead
    // of inheriting a black frame from a dark macOS system appearance.
    nativeTheme.themeSource = 'light';
    Menu.setApplicationMenu(null);
    await bootDesktop();
  });
}

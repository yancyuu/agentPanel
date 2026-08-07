import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell } from 'electron';

import { stopUsageTelemetryWorkers } from '../main/telemetry/workerSingleton';
import { DESKTOP_RUNTIME_METADATA_FILE, DESKTOP_SESSION_HEADER } from '../shared/constants/desktop';
import { writeAtomicFile } from '../shared/writeAtomic/index.mjs';

import {
  buildDesktopServerEnvironment,
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
let splashWindow: BrowserWindow | null = null;
let runningServer: RunningServer | null = null;
let bootPromise: Promise<void> | null = null;
let shutdownStarted = false;
let allowQuit = false;

function desktopWindowIcon(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'agentpanel.ico')
    : path.join(app.getAppPath(), 'resources', 'icons', 'win', 'icon.ico');
}

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

function installSessionSecurity(server: RunningServer): void {
  const desktopSession = session.fromPartition('persist:agentpanel-desktop');
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

function createStartupSplash(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'AgentPanel',
    icon: desktopWindowIcon(),
    show: true,
    width: 480,
    height: 340,
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#24225f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentPanel</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 76% 18%,#7068ff 0,transparent 38%),linear-gradient(145deg,#3430c8,#272278 62%,#171747);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.content{display:grid;justify-items:center;gap:18px}.mark{position:relative;width:82px;height:82px;border-radius:24px;background:#fff;box-shadow:0 18px 48px rgba(9,7,69,.33)}.mark:before{content:"";position:absolute;inset:18px;border:10px solid #4d48db;border-radius:19px}.dot{position:absolute;top:25px;right:15px;width:19px;height:19px;border-radius:50%;background:#ff9138;box-shadow:0 0 0 8px rgba(255,145,56,.14);animation:pulse 1.45s ease-in-out infinite}h1{margin:0;font-size:22px;letter-spacing:.02em}.hint{margin:0;color:rgba(255,255,255,.72);font-size:13px}.bar{width:190px;height:4px;border-radius:999px;background:rgba(255,255,255,.18);overflow:hidden}.bar:before{content:"";display:block;width:48%;height:100%;border-radius:inherit;background:#ff9b4b;animation:progress 1.15s ease-in-out infinite}@keyframes pulse{50%{transform:scale(1.18);box-shadow:0 0 0 14px rgba(255,145,56,0)}}@keyframes progress{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}</style><div class="content"><div class="mark"><i class="dot"></i></div><h1>AgentPanel</h1><p class="hint">正在准备本地智能体工作台…</p><div class="bar"></div></div></html>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return window;
}

function closeStartupSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

async function createWorkbenchWindow(server: RunningServer): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: 'AgentPanel',
    icon: desktopWindowIcon(),
    show: false,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f7f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:agentpanel-desktop',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedWorkbenchNavigation(targetUrl, server.origin)) event.preventDefault();
  });
  await window.loadURL(`${server.origin}/`);
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
    title: 'AgentPanel 启动失败',
    icon: desktopWindowIcon(),
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
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentPanel 启动失败</title><style>body{margin:0;background:#171719;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.wrap{max-width:640px;margin:64px auto;padding:0 28px}h1{font-size:22px}p{color:#bbb;line-height:1.7}.actions{display:flex;gap:12px;margin:24px 0}a{display:inline-block;border-radius:8px;background:#4f46e5;color:white;padding:10px 16px;text-decoration:none}pre{max-height:220px;overflow:auto;border:1px solid #333;border-radius:8px;background:#101011;padding:12px;color:#aaa;font:11px ui-monospace,monospace;white-space:pre-wrap}</style><div class="wrap"><h1>客户端暂时无法启动</h1><p>${escapeHtml(message)}</p><p>请点击重试。如果仍然失败，可以退出后重新打开客户端。</p><div class="actions"><a href="agentpanel://retry">重试</a><a href="agentpanel://quit">退出</a></div>${logText ? `<pre>${escapeHtml(logText)}</pre>` : ''}</div></html>`;
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl === 'agentpanel://retry') {
      event.preventDefault();
      window.once('closed', () => void bootDesktop());
      window.close();
    } else if (targetUrl === 'agentpanel://quit') {
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
  splashWindow ??= createStartupSplash();
  try {
    runningServer = await startServer();
    installSessionSecurity(runningServer);
    const window = await createWorkbenchWindow(runningServer);
    trackMainWindow(window);
    closeStartupSplash();
    window.show();
  } catch (error) {
    console.error('[AgentPanel desktop] boot failed', error);
    const logs = runningServer?.logs ?? [];
    runningServer = null;
    closeStartupSplash();
    try {
      trackMainWindow(createFailureWindow(error, logs));
    } catch (failureWindowError) {
      console.error('[AgentPanel desktop] failure window creation failed', failureWindowError);
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

async function runQuietCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/** Retire the old opt-in Usage worker without touching historical local data. */
async function disableLegacyUsageAutostart(): Promise<void> {
  if (process.platform === 'darwin') {
    const plistPath = path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      'com.openhermit.telemetry.plist'
    );
    const uid = process.getuid?.();
    if (uid !== undefined) await runQuietCommand('launchctl', ['bootout', `gui/${uid}`, plistPath]);
    await rm(plistPath, { force: true });
    return;
  }
  if (process.platform === 'win32') {
    await runQuietCommand('schtasks.exe', ['/Delete', '/F', '/TN', 'AgentPanel Usage Telemetry']);
  }
}

function resolveDeliveryDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  const teamsRoot = path.resolve(os.homedir(), '.hermit', 'teams');
  const directory = path.resolve(value);
  const relative = path.relative(teamsRoot, directory);
  const segments = relative.split(path.sep);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !segments.includes('outputs')
  ) {
    return null;
  }
  return directory;
}

ipcMain.handle('agentpanel:relaunch', async () => {
  app.relaunch();
  setImmediate(() => app.quit());
});

ipcMain.handle('agentpanel:open-external', async (_event, url: unknown) => {
  if (typeof url !== 'string' || url.length > 2048 || !isAllowedExternalUrl(url)) {
    return { success: false, error: '不支持打开该链接' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false, error: '无法打开外部链接' };
  }
});

ipcMain.handle('agentpanel:open-delivery-folder', async (_event, value: unknown) => {
  const directory = resolveDeliveryDirectory(value);
  if (!directory) return { success: false, error: '成果目录无效' };
  try {
    const error = await shell.openPath(directory);
    return error ? { success: false, error } : { success: true };
  } catch {
    return { success: false, error: '无法打开成果文件夹' };
  }
});

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
    if (process.platform === 'win32') app.setAppUserModelId('com.yancyyu.agentpanel');
    // Keep the native title bar aligned with the default light workbench instead
    // of inheriting a black frame from a dark macOS system appearance.
    nativeTheme.themeSource = 'light';
    Menu.setApplicationMenu(null);
    // User-facing Usage collection is retired; stop any legacy worker but keep
    // its historical local files intact.
    await stopUsageTelemetryWorkers().catch(() => undefined);
    await disableLegacyUsageAutostart().catch(() => undefined);
    await bootDesktop();
  });
}

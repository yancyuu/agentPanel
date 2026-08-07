// daemon.mjs — background-daemon process management: pidfile helpers, signal
// forwarding, fallback-process cleanup, daemon status, and start/stop/ready-wait.

import { spawn, execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

import {
  binDir,
  currentVersion,
  daemonLogPath,
  daemonPidPath,
  hermitHome,
  jsonRequested,
  port,
  repoRoot,
} from './env.mjs';
import { brandCommand } from '../branding.mjs';
import { printCliRows, printJson } from './terminal.mjs';
import { appendLog, checkExistingOpenHermitServer, isTcpPortAvailable } from './runtime.mjs';

// The daemon child must re-enter bin/hermit.mjs (which owns the server-start
// fall-through at the bottom of that file). Spawning daemon.mjs itself does
// nothing — it has no run-as-script entry — so the child exited immediately and
// the web console never came up.
const hermitEntry = path.join(binDir, 'hermit.mjs');

// Read any pidfile (daemon, telemetry worker, …) → live pid or null. The daemon
// pid is just this applied to daemonPidPath (see readDaemonPid below); the
// generic form is shared by the telemetry worker and feature-state lookups.
function readPidFile(pidPath) {
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readDaemonPid() {
  return readPidFile(daemonPidPath);
}

function refreshDaemonPidFromReadyServer(pid) {
  if (!pid || !isPidRunning(pid)) return;
  try {
    mkdirSync(path.dirname(daemonPidPath), { recursive: true });
    writeFileSync(daemonPidPath, String(pid), 'utf-8');
  } catch {
    // PID refresh must not block the menu; server readiness is the source of truth.
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeDaemonPidFile() {
  try {
    unlinkSync(daemonPidPath);
  } catch {
    // Already gone.
  }
}

function signalDaemon(pid, signal) {
  if (!pid) return false;
  // Process-group signaling (negative pid) is a Unix concept; on Windows
  // process.kill(-pid) always throws EINVAL. Skip it on win32 and go straight
  // to the direct signal, avoiding a guaranteed exception every call. The
  // Unix path (group first → direct fallback) is unchanged.
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to direct process signal.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Windows process snapshot via PowerShell (wmic is removed on Win11 24H2+).
// pid+ppid+command are emitted on the SAME output line, so a parse glitch can
// only DROP a process (false negative → callers degrade to today's no-op),
// never mismatch pid↔command (no wrong kills). Callers wrap in try/catch, so a
// PowerShell failure also → []. ASCII pid/ppid + ASCII match-substrings mean a
// non-UTF8 command portion (e.g. GBK on zh-CN Windows) doesn't affect matching.
function listProcessesWin() {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
    ],
    { encoding: 'utf-8', windowsHide: true },
  );
  const procs = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('\t');
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    procs.push({ pid, ppid: Number(parts[1]) || 0, command: parts.slice(2).join('\t') });
  }
  return procs;
}

// Windows fallback pid collection (no lsof/pgrep): pid-by-listening-port via
// netstat + pid-by-command-pattern via listProcessesWin. Mirrors the Unix
// collectFallbackPids intent; each step isolated so a missing tool only drops
// that step's contribution.
function collectFallbackPidsWin() {
  const pids = new Set();
  const watchPorts = new Set([port, 9810, 9820]);
  try {
    const netstat = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    for (const line of netstat.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (!cols.includes('LISTENING') || cols.length < 4) continue;
      const localPort = Number(cols[1].split(':').pop());
      const pid = Number(cols[cols.length - 1]);
      if (watchPorts.has(localPort) && Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
  } catch {
    // netstat unavailable — fall through to command match.
  }
  try {
    // Covers: both package eras (@yancyyu/openhermit, @yancyyu/agentpanel), the
    // CLI daemon entry (hermit.mjs), the fastify server, the telemetry worker
    // (src/main/telemetry/worker.ts — NOT matched by server.ts, which is why it
    // used to survive `agentpanel stop`), and the cc-connect runtime. Anything
    // matching one of these is product infrastructure, never user code.
    const pattern = /openhermit|agentpanel|hermit\.mjs|server\.ts|telemetry[\\/]worker\.ts|hermit-bridge|cc-connect/u;
    for (const p of listProcessesWin()) {
      if (p.pid !== process.pid && pattern.test(p.command)) pids.add(p.pid);
    }
  } catch {
    // PowerShell unavailable — keep whatever netstat found.
  }
  return [...pids];
}

function collectFallbackPids() {
  if (process.platform === 'win32') return collectFallbackPidsWin();
  const pids = new Set();
  const commands = [
    `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`,
    'lsof -tiTCP:9810 -sTCP:LISTEN 2>/dev/null || true',
    'lsof -tiTCP:9820 -sTCP:LISTEN 2>/dev/null || true',
    "pgrep -f '@yancyyu/openhermit|@yancyyu/agentpanel|openhermit/bin/hermit\\.mjs|agentpanel/bin/hermit\\.mjs|src/main/server\\.ts|src/main/telemetry/worker\\.ts|hermit-bridge|cc-connect' 2>/dev/null || true",
  ];

  for (const command of commands) {
    try {
      const out = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\s+/)) {
        const pid = Number.parseInt(line, 10);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
          pids.add(pid);
        }
      }
    } catch {
      // Ignore missing lsof/pgrep or races with exiting processes.
    }
  }

  return [...pids];
}

// Detached daemon children (server.ts / hermit-bridge) are spawned with
// detached:true and only reaped by shutdown() on SIGINT/SIGTERM. If the daemon
// dies via SIGKILL / crash / OOM, shutdown() never runs and those children are
// reparented to PID 1 — permanent orphans. Reap ONLY PPID=1 ones at startup so
// a LIVE daemon's own children are never touched.
function collectOrphanedDaemonChildPids() {
  if (process.platform === 'win32') {
    // Windows has no PID-1 reparenting: an orphan keeps its (now-dead) parent's
    // ppid, so "orphan" = ppid not in the live-pid set.
    try {
      const procs = listProcessesWin();
      const live = new Set(procs.map((p) => p.pid));
      return procs
        .filter((p) => p.pid !== process.pid && !live.has(p.ppid)
          && !p.command.includes('--scan-once')
          && (p.command.includes('src/main/server.ts') || p.command.includes('src/main/telemetry/worker.ts') || p.command.includes('hermit-bridge') || p.command.includes('cc-connect')))
        .map((p) => p.pid);
    } catch {
      return [];
    }
  }
  let output = '';
  try {
    output = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf-8' });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (pid === process.pid) continue;
    if (ppid !== 1) continue; // only true orphans — never a live daemon's child
    if (command.includes('--scan-once')) continue; // transient foreground scan
    if (command.includes('src/main/server.ts') || command.includes('src/main/telemetry/worker.ts') || command.includes('hermit-bridge') || command.includes('cc-connect')) {
      pids.push(pid);
    }
  }
  return pids;
}

async function stopFallbackProcesses(pids = collectFallbackPids()) {
  if (pids.length === 0) return false;

  for (const pid of pids) {
    signalDaemon(pid, 'SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const pid of pids) {
    if (isPidRunning(pid)) {
      signalDaemon(pid, 'SIGKILL');
    }
  }
  return true;
}

async function collectDaemonStatus() {
  const pid = readDaemonPid();
  const pidRunning = Boolean(pid && isPidRunning(pid));
  const fallbackPids = pidRunning ? [] : collectFallbackPids();
  const server = await checkExistingOpenHermitServer();

  return {
    running: pidRunning || fallbackPids.length > 0 || server.running,
    version: currentVersion,
    port: Number.parseInt(port, 10),
    url: `http://127.0.0.1:${port}`,
    hermitHome,
    daemonPidPath,
    daemonLogPath,
    pid: pidRunning ? pid : null,
    pidfilePresent: Boolean(pid),
    fallbackPids,
    server,
  };
}


async function printDaemonStatus({ exitOnDone = true } = {}) {
  const status = await collectDaemonStatus();
  if (jsonRequested) {
    printJson({ ok: status.running, command: 'status', status }, status.running ? 0 : 1);
  }

  if (status.pid) {
    printCliRows('后台服务', [
      ['状态', `运行中 (pid ${status.pid})`],
      ['地址', status.url],
      ['日志', daemonLogPath],
    ], `停止服务可运行：${brandCommand('stop')}`);
    if (exitOnDone) process.exit(0);
    return status;
  }
  if (status.fallbackPids.length > 0) {
    printCliRows('后台服务', [
      ['状态', `运行中，无 daemon pidfile (pids ${status.fallbackPids.join(', ')})`],
      ['地址', status.url],
    ], '需要清理时可运行：agentpanel stop');
    if (exitOnDone) process.exit(0);
    return status;
  }
  if (status.server.running) {
    printCliRows('后台服务', [
      ['状态', '运行中'],
      ['地址', status.server.url],
      ['版本', status.server.version],
    ], '复杂设置请在 Web 控制台中完成。');
    if (exitOnDone) process.exit(0);
    return status;
  }
  printCliRows('后台服务', [
    ['状态', '未运行'],
    ['地址', status.url],
  ], `启动服务可运行：${brandCommand('--daemon')}`);
  if (exitOnDone) process.exit(1);
  return status;
}

async function stopDaemon({ exitOnDone = true, quiet = false } = {}) {
  const pid = readDaemonPid();
  if (!pid || !isPidRunning(pid)) {
    if (pid) removeDaemonPidFile();
    const stoppedFallback = await stopFallbackProcesses();
    if (!quiet) {
      printCliRows('后台服务', [
        ['状态', stoppedFallback ? '已停止残留服务进程' : '未运行'],
        ['地址', `http://127.0.0.1:${port}`],
      ], stoppedFallback ? `如需重新启动可运行：${brandCommand('--daemon')}` : '无需处理。');
    }
    if (exitOnDone) process.exit(0);
    return { stopped: stoppedFallback, pid: null };
  }
  if (!quiet) {
    printCliRows('后台服务', [
      ['状态', `正在停止 (pid ${pid})`],
      ['地址', `http://127.0.0.1:${port}`],
    ]);
  }
  signalDaemon(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (isPidRunning(pid)) {
    signalDaemon(pid, 'SIGKILL');
  }
  removeDaemonPidFile();
  // Clean up orphaned child processes (cc-connect on 9820, bridge on 9810,
  // server on <port>). On Unix, the daemon's shutdown() handler kills these
  // when it gets SIGTERM. On Windows, SIGTERM from an external process
  // TerminateProcess'es the daemon WITHOUT running process.on('SIGTERM'), so
  // shutdown() never runs and the children become orphans — which is exactly
  // why users had to run `services stop web` twice on Windows (first call
  // killed only the daemon, second call's fallback scan reaped the orphans).
  // Running the fallback scan here unconditionally closes that gap in one shot.
  await stopFallbackProcesses();
  if (!quiet) {
    printCliRows('后台服务', [
      ['状态', '已停止'],
      ['地址', `http://127.0.0.1:${port}`],
    ], `如需重新启动可运行：${brandCommand('--daemon')}`);
  }
  if (exitOnDone) process.exit(0);
  return { stopped: true, pid };
}

async function waitForOpenHermitServerReady(pid, timeoutMs = 120_000) {
  // The HTTP probe (/api/version) is the source of truth — NOT the spawned pid.
  // The pid is a launcher that hands off to a reparented src/main/server.ts
  // grandchild and may exit on its own, so a dead launcher pid is not a failure.
  // Cold tsx boots are also slow. So: keep polling the probe; only fail fast on a
  // genuine crash (launcher dead AND nothing binding the port). At the deadline,
  // re-probe once more (the server may have bound the instant it expired) and,
  // if the port is still bound by a booting process, report `stillBooting`
  // instead of a false "启动失败" for a workbench that actually came up.
  const portNum = Number.parseInt(port, 10);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const server = await checkExistingOpenHermitServer();
    if (server.running) return { ready: true, ...server };
    if (pid && !isPidRunning(pid)) {
      const portBound = !(await isTcpPortAvailable(portNum));
      if (!portBound) {
        return { ready: false, reason: '服务进程已退出，请查看日志', url: `http://127.0.0.1:${port}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const final = await checkExistingOpenHermitServer();
  if (final.running) return { ready: true, ...final };
  const stillBooting = !(await isTcpPortAvailable(portNum)) || (pid ? isPidRunning(pid) : false);
  return {
    ready: false,
    stillBooting,
    reason: stillBooting
      ? '工作台仍在启动中（冷启动较慢），稍后刷新即可使用'
      : '服务还没准备好，请稍后刷新或查看日志',
    url: `http://127.0.0.1:${port}`,
  };
}

function startDaemon({ exitOnDone = true, quiet = false, childArgs } = {}) {
  const url = `http://127.0.0.1:${port}`;
  const existingPid = readDaemonPid();
  if (existingPid && isPidRunning(existingPid)) {
    if (!quiet) {
      printCliRows('后台服务', [
        ['状态', `已运行 (pid ${existingPid})`],
        ['地址', url],
        ['日志', daemonLogPath],
      ], `停止服务可运行：${brandCommand('stop')}`);
    }
    if (exitOnDone) process.exit(0);
    return { started: false, pid: existingPid, url, logPath: daemonLogPath };
  }

  mkdirSync(path.dirname(daemonPidPath), { recursive: true });
  mkdirSync(path.dirname(daemonLogPath), { recursive: true });
  const out = openSync(daemonLogPath, 'a');
  const err = openSync(daemonLogPath, 'a');
  const daemonChildArgs = childArgs ?? process.argv.slice(2).filter((arg) => arg !== '--daemon');
  appendLog(
    daemonLogPath,
    `${new Date().toISOString()} daemon-child-spawn entry=${hermitEntry} args=[${daemonChildArgs.join(' ')}] port=${port}\n`
  );
  const child = spawn(process.execPath, [hermitEntry, ...daemonChildArgs], {
    cwd: repoRoot,
    // Windows: run the daemon DETACHED from the launching console. A
    // non-detached child shares the console's process list, so closing the
    // terminal sends CTRL_CLOSE_EVENT to it and kills the whole workbench
    // (server.ts + cc-connect go down with it) — the reported "关终端进程全灭".
    // DETACHED_PROCESS removes the child from that group. Historically this
    // was avoided because "detached defeats windowsHide"; on current Windows
    // + Node, detached + windowsHide + stdio-to-file spawns NO console window
    // (verified: no new conhost process), so there is no black-box tradeoff.
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      HERMIT_DAEMON_CHILD: '1',
    },
    stdio: ['ignore', out, err],
  });
  child.unref();
  closeSync(out);
  closeSync(err);
  writeFileSync(daemonPidPath, String(child.pid), 'utf-8');
  if (!quiet) {
    printCliRows('后台服务', [
      ['状态', `已启动 (pid ${child.pid})`],
      ['地址', url],
      ['日志', daemonLogPath],
    ], `停止服务可运行：${brandCommand('stop')}`);
  }
  if (exitOnDone) process.exit(0);
  return { started: true, pid: child.pid, url, logPath: daemonLogPath };
}


export {
readPidFile,
readDaemonPid,
refreshDaemonPidFromReadyServer,
isPidRunning,
removeDaemonPidFile,
signalDaemon,
listProcessesWin,
collectFallbackPids,
collectOrphanedDaemonChildPids,
stopFallbackProcesses,
collectDaemonStatus,
printDaemonStatus,
stopDaemon,
waitForOpenHermitServerReady,
startDaemon,
};

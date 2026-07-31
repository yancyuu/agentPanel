// workerSingleton.ts — enforce the "at most one telemetry worker" invariant.
//
// The pidfile is the canonical worker handle, but it goes stale when a worker
// dies via SIGKILL / crash / reboot (its removePid() never runs) — leaving a live
// orphan the pidfile no longer names. A freshly booted worker (e.g. right after a
// package reinstall, with no manual `usage stop`) must therefore reap any OTHER
// live telemetry/worker.ts daemon before claiming the pidfile, so "exactly one"
// holds regardless of how the worker was launched.
//
// ps/command matching mirrors the CLI reaper (bin/hermit.mjs collectRunningUsageWorkerPids):
// match every persistent telemetry/worker.ts daemon, exclude self and transient
// --scan-once foreground scans (those self-exit after one scan; usage report must
// not be killed mid-scan).
import { execFileSync, execSync } from 'node:child_process';

const REAP_GRACE_MS = 200;

export function isUsageWorkerCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('telemetry/worker.ts') ||
    normalized.includes('dist/telemetry-worker.bundle.mjs')
  );
}

function isTransientWorkerCommand(command: string): boolean {
  return ['--scan-once', '--startup-once', '--report-lark-credentials-once'].some((flag) =>
    command.includes(flag)
  );
}

/**
 * Parse `ps -axo pid=,command=` output into the pids of OTHER live worker daemons.
 * Pure (no I/O) so it can be unit-tested directly.
 */
export function parseOtherUsageWorkerPids(psOutput: string, selfPid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^(\d+)\s+([\s\S]+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === selfPid) continue;
    const command = match[2];
    if (!isUsageWorkerCommand(command)) continue;
    if (isTransientWorkerCommand(command)) continue;
    pids.push(pid);
  }
  return pids;
}

export function parseWindowsUsageWorkerPids(output: string, selfPid: number): number[] {
  if (!output.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const pid = Number(record.ProcessId ?? record.processId);
      const command = String(record.CommandLine ?? record.commandLine ?? '');
      if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return [];
      if (!isUsageWorkerCommand(command) || isTransientWorkerCommand(command)) return [];
      return [pid];
    });
  } catch {
    return [];
  }
}

/** Live process snapshot → pids of other worker daemons. */
export function listOtherUsageWorkerPids(selfPid = process.pid): number[] {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf-8', windowsHide: true }
      );
      return parseWindowsUsageWorkerPids(output, selfPid);
    } catch {
      return [];
    }
  }
  let output = '';
  try {
    output = execSync('ps -axo pid=,command=', { encoding: 'utf-8' });
  } catch {
    return [];
  }
  return parseOtherUsageWorkerPids(output, selfPid);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM every other live worker daemon, then SIGKILL any survivor after a short
 * grace. Called at worker boot so a new worker always supersedes stale orphans —
 * the pidfile is reclaimed by the caller via writePid() once this resolves.
 */
export async function reapOtherUsageWorkers(selfPid = process.pid): Promise<void> {
  const killAll = (sig: 'SIGTERM' | 'SIGKILL') => {
    for (const pid of listOtherUsageWorkerPids(selfPid)) {
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, sig);
        } catch {
          /* already gone */
        }
      }
    }
  };
  killAll('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, REAP_GRACE_MS));
  killAll('SIGKILL');
}

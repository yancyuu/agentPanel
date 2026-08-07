import { describe, expect, it } from 'vitest';

import {
  isUsageWorkerCommand,
  parseOtherUsageWorkerPids,
  parseWindowsUsageWorkerPids,
} from '../workerSingleton';

// Sample `ps -axo pid=,command=` output covering every case the reaper must
// distinguish: the self daemon, a peer daemon, a transient --scan-once child,
// a global-package daemon (different install path), and an unrelated process.
const PS_OUTPUT = [
  ' 42790 /usr/local/bin/node --import ...tsx/dist/loader.mjs src/main/telemetry/worker.ts',
  ' 14726 node src/main/telemetry/worker.ts',
  ' 99999 node src/main/telemetry/worker.ts --scan-once',
  ' 99998 node src/main/telemetry/worker.ts --startup-once',
  ' 50001 /usr/local/bin/node ~/.npm-global/.../openhermit/src/main/telemetry/worker.ts',
  ' 50002 /opt/AgentPanel/resources/agentpanel/dist/telemetry-worker.bundle.mjs',
  ' 50003 /opt/AgentPanel/resources/agentpanel/dist/telemetry-worker.bundle.mjs --startup-once',
  ' 12345 /usr/local/bin/node src/main/server.ts',
  '',
].join('\n');

describe('parseOtherUsageWorkerPids', () => {
  it('collects peer daemons while excluding every transient one-shot mode', () => {
    const pids = parseOtherUsageWorkerPids(PS_OUTPUT, 42790);
    // Self and every one-shot child are excluded; server.ts is unrelated.
    expect(pids).toContain(14726);
    expect(pids).toContain(50001);
    expect(pids).not.toContain(99999);
    expect(pids).not.toContain(99998);
    expect(pids).toEqual([14726, 50001, 50002]);
  });

  it('matches source and packaged worker entry points across slash styles', () => {
    expect(isUsageWorkerCommand('node C:\\AgentPanel\\dist\\telemetry-worker.bundle.mjs')).toBe(
      true
    );
    expect(isUsageWorkerCommand('node /app/src/main/telemetry/worker.ts')).toBe(true);
    expect(isUsageWorkerCommand('node /app/src/main/server.ts')).toBe(false);
  });

  it('parses Windows process JSON and excludes transient or unrelated processes', () => {
    const output = JSON.stringify([
      {
        ProcessId: 7001,
        CommandLine: 'node C:\\AgentPanel\\dist\\telemetry-worker.bundle.mjs',
      },
      {
        ProcessId: 7002,
        CommandLine: 'node C:\\AgentPanel\\dist\\telemetry-worker.bundle.mjs --scan-once',
      },
      { ProcessId: 7003, CommandLine: 'node C:\\AgentPanel\\dist\\server.bundle.mjs' },
      {
        ProcessId: 7004,
        CommandLine: 'node C:\\AgentPanel\\src\\main\\telemetry\\worker.ts',
      },
    ]);

    expect(parseWindowsUsageWorkerPids(output, 7004)).toEqual([7001]);
  });

  it('matches a global-package install path worker (orphan with no pidfile entry)', () => {
    // Self is the local daemon; the global-package daemon (50001) must still be found.
    const pids = parseOtherUsageWorkerPids(PS_OUTPUT, 42790);
    expect(pids).toContain(50001);
  });

  it('returns empty when only self / no other worker is running', () => {
    expect(parseOtherUsageWorkerPids(' 42790 node src/main/telemetry/worker.ts', 42790)).toEqual(
      []
    );
    expect(parseOtherUsageWorkerPids(' 12345 node src/main/server.ts', 42790)).toEqual([]);
    expect(parseOtherUsageWorkerPids('', 42790)).toEqual([]);
  });

  it('ignores malformed lines but keeps valid ones', () => {
    const out = [
      'garbage line',
      '',
      ' notapid telemetry/worker.ts',
      ' 7 node telemetry/worker.ts',
    ].join('\n');
    expect(parseOtherUsageWorkerPids(out, 42790)).toEqual([7]);
  });
});

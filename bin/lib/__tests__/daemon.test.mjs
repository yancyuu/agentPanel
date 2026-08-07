// Regression: startDaemon used to spawn bin/lib/daemon.mjs itself as the daemon
// child, but daemon.mjs has no run-as-script entry — the child loaded the module
// and exited immediately, so the web console never came up. It must re-enter
// bin/hermit.mjs (which owns the server-start fall-through at the bottom).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => {
  // node:child_process is CJS, so the mock must expose a `default` too or the
  // named-import interop throws "No default export is defined". startDaemon only
  // uses spawn; the rest are no-ops so we never hit the real process layer.
  const mocked = { spawn: mocks.spawn, execSync: () => '', exec: () => {}, fork: () => {} };
  return { ...mocked, default: mocked };
});

describe('startDaemon spawn target', () => {
  let tmpHome;
  let startDaemon;

  beforeAll(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-daemon-'));
    // env.mjs captures HERMIT_HOME at import time, so set it before the one
    // dynamic import (after resetModules) so pid/log files land in tmpHome.
    process.env.HERMIT_HOME = tmpHome;
    vi.resetModules();
    ({ startDaemon } = await import('../daemon.mjs'));
  });

  afterAll(async () => {
    delete process.env.HERMIT_HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => ({ pid: 99999, unref() {}, on() {} }));
  });

  it('re-spawns bin/hermit.mjs as the daemon child, not daemon.mjs', async () => {
    await startDaemon({ exitOnDone: false, quiet: true });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [exe, spawnArgs, opts] = mocks.spawn.mock.calls.at(-1);
    expect(exe).toBe(process.execPath);
    expect(spawnArgs[0]).toMatch(/[\\/]bin[\\/]hermit\.mjs$/u);
    expect(spawnArgs[0]).not.toMatch(/daemon\.mjs$/u);
    expect(opts.env.HERMIT_DAEMON_CHILD).toBe('1');
    expect(spawnArgs).not.toContain('--daemon');
  });

  it('forwards --port (and other) args to the child while dropping --daemon', async () => {
    await startDaemon({ exitOnDone: false, quiet: true, childArgs: ['--port', '8080'] });

    const [, spawnArgs] = mocks.spawn.mock.calls.at(-1);
    expect(spawnArgs).toContain('--port');
    expect(spawnArgs).toContain('8080');
    expect(spawnArgs).not.toContain('--daemon');
  });
});

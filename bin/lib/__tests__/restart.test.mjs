// restart.test.mjs — restart only the local Workbench.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopDaemon: vi.fn(),
  startDaemon: vi.fn(),
}));

vi.mock('../daemon.mjs', () => ({
  stopDaemon: mocks.stopDaemon,
  startDaemon: mocks.startDaemon,
}));

describe('runRestart — cycles the local Workbench without Usage telemetry', () => {
  let runRestart;

  beforeAll(async () => {
    ({ runRestart } = await import('../restart.mjs'));
  });

  beforeEach(() => {
    mocks.stopDaemon.mockReset();
    mocks.startDaemon.mockReset();
    mocks.stopDaemon.mockResolvedValue({ stopped: true, pid: 123 });
    mocks.startDaemon.mockReturnValue({
      started: true,
      pid: 456,
      url: 'http://127.0.0.1:5680',
      logPath: 'agentpanel-daemon.log',
    });
  });

  it('stops then starts the Workbench with clean child arguments', async () => {
    await runRestart({ quiet: true });

    expect(mocks.stopDaemon).toHaveBeenCalledBefore(mocks.startDaemon);
    expect(mocks.startDaemon).toHaveBeenCalledWith({
      exitOnDone: false,
      quiet: true,
      childArgs: [],
    });
  });

  it('returns only the local Workbench restart result', async () => {
    await expect(runRestart({ quiet: true })).resolves.toMatchObject({
      ok: true,
      command: 'restart',
      daemon: { started: true, pid: 456 },
    });
  });
});

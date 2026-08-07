import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'bin/hermit.mjs');
const servers: ReturnType<typeof createServer>[] = [];

async function runCli(args: string[], env: Record<string, string> = {}) {
  const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-cli-'));
  try {
    return await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMIT_HOME: hermitHome,
        HOME: hermitHome,
        USERPROFILE: hermitHome,
        ...env,
      },
    });
  } finally {
    await rm(hermitHome, { recursive: true, force: true });
  }
}

async function startWorkbenchServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    let payload: unknown = { ok: false, error: 'not found' };
    if (url.pathname === '/api/teams') payload = [];
    else if (url.pathname === '/api/task-bus/tasks') payload = { data: [] };
    else if (url.pathname === '/api/external-channels') {
      payload = {
        ccConnect: {
          enabled: false,
          active: false,
          restartRequired: false,
          state: 'disabled',
        },
      };
    }
    response.writeHead(url.pathname === '/missing' ? 404 : 200, {
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Workbench did not bind');
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('AgentPanel local Workbench commands', () => {
  it('advertises only the local runtime, task, delivery, and optional plugin commands', async () => {
    const { stdout } = await runCli(['--help']);

    expect(stdout).toContain('external-channels cc-connect status|enable|disable');
    expect(stdout).toContain('deliveries github bindings|bind|unbind|publish');
    expect(stdout).not.toMatch(/usage report|collaboration start|auth login|飞书授权|AgentBus/u);
  });

  it('rejects retired cloud, usage, and direct-channel commands without starting a runtime', async () => {
    for (const command of [
      ['usage', 'status'],
      ['auth', 'status'],
      ['collaboration', 'start'],
      ['create-feishu-assistant', '--name', 'old'],
    ]) {
      await expect(runCli([...command, '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('未知命令'),
      });
    }
  });

  it('uses the Workbench HTTP API for teams, tasks, and external-channel state', async () => {
    const { origin, requests } = await startWorkbenchServer();
    const env = { HERMIT_WORKBENCH_URL: origin };

    const teams = JSON.parse((await runCli(['teams', 'list', '--json'], env)).stdout);
    const tasks = JSON.parse(
      (await runCli(['tasks', 'list', '--team', 'demo', '--json'], env)).stdout
    );
    const channels = JSON.parse(
      (await runCli(['external-channels', 'cc-connect', 'status', '--json'], env)).stdout
    );

    expect(teams).toMatchObject({ ok: true, command: 'teams list', teams: [] });
    expect(tasks).toMatchObject({
      ok: true,
      command: 'tasks list',
      source: 'workbench',
      tasks: [],
    });
    expect(channels).toMatchObject({ ok: true, ccConnect: { state: 'disabled' } });
    expect(requests).toEqual(
      expect.arrayContaining(['/api/teams', '/api/task-bus/tasks', '/api/external-channels'])
    );
  });
});

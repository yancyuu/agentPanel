import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'bin/hermit.mjs');
const servers: ReturnType<typeof createServer>[] = [];

async function startTaskBusServer() {
  const requests: { pathname: string; body?: unknown }[] = [];
  const task = {
    id: 'task-12345678',
    displayId: 'task-123',
    subject: 'Ship CLI task bus',
    status: 'in_progress',
    owner: 'team-b',
  };
  const server = createServer((request, response) => {
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      requests.push({ pathname, body });
      const data = pathname === '/api/task-bus/tasks' ? [task] : { ok: true, task };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('task bus server did not bind');
  return { port: String(address.port), requests, task };
}

async function runCli(port: string, args: string[]) {
  return execFileAsync(process.execPath, [cliPath, '--port', port, ...args, '--json'], {
    cwd: repoRoot,
  });
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

describe('Hermit CLI task bus', () => {
  it('uses the injected Workbench URL when no explicit port is provided', async () => {
    const { port, task } = await startTaskBusServer();
    const response = await execFileAsync(
      process.execPath,
      [cliPath, 'tasks', 'list', '--team', 'team-b', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, HERMIT_WORKBENCH_URL: `http://127.0.0.1:${port}` },
      }
    );

    expect(JSON.parse(response.stdout)).toMatchObject({
      source: 'task-bus',
      tasks: [expect.objectContaining({ id: task.id })],
    });
  });

  it('lists, claims, comments, clarifies, and completes tasks through the Workbench API', async () => {
    const { port, requests, task } = await startTaskBusServer();

    const listed = JSON.parse((await runCli(port, ['tasks', 'list', '--team', 'team-b'])).stdout);
    expect(listed).toMatchObject({
      ok: true,
      command: 'tasks list',
      team: 'team-b',
      source: 'task-bus',
      tasks: [expect.objectContaining({ id: task.id })],
    });

    for (const args of [
      ['tasks', 'claim', '--team', 'team-b', '--id', task.id],
      ['tasks', 'comment', '--team', 'team-b', '--id', task.id, '--text', '处理中'],
      ['tasks', 'clarify', '--team', 'team-b', '--id', task.id, '--target', 'user'],
      ['tasks', 'complete', '--team', 'team-b', '--id', task.id, '--result', '已完成'],
    ]) {
      expect(JSON.parse((await runCli(port, args)).stdout)).toMatchObject({ ok: true });
    }

    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathname: `/api/task-bus/tasks/${task.id}/claim`,
          body: { team: 'team-b' },
        }),
        expect.objectContaining({
          pathname: `/api/task-bus/tasks/${task.id}/comments`,
          body: { team: 'team-b', text: '处理中' },
        }),
        expect.objectContaining({
          pathname: `/api/task-bus/tasks/${task.id}/clarification`,
          body: { team: 'team-b', target: 'user' },
        }),
        expect.objectContaining({
          pathname: `/api/task-bus/tasks/${task.id}/complete`,
          body: { team: 'team-b', result: '已完成' },
        }),
      ])
    );
  });
});

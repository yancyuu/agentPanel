import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(repoRoot, 'bin/hermit.mjs');

async function runCli(hermitHome: string, args: string[], env: Record<string, string> = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    // Isolate the MACHINE home, not just HERMIT_HOME: on Windows os.homedir()
    // reads USERPROFILE (HOME is usually unset), so HOME-only isolation still
    // lets Codex/upload scans find the developer's real sessions — making
    // token assertions machine-dependent and empty-dir scans take minutes.
    env: {
      ...process.env,
      HERMIT_HOME: hermitHome,
      HOME: hermitHome,
      USERPROFILE: hermitHome,
      ...env,
    },
  });
}

async function withHermitHome<T>(fn: (hermitHome: string) => Promise<T>) {
  const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'openhermit-cli-'));
  try {
    return await fn(hermitHome);
  } finally {
    await rm(hermitHome, { recursive: true, force: true });
  }
}

async function seedOpenHermitAuth(hermitHome: string) {
  await mkdir(path.join(hermitHome, 'auth'), { recursive: true });
  await writeFile(
    path.join(hermitHome, 'auth/openhermit.json'),
    JSON.stringify({
      schemaVersion: 1,
      provider: 'openhermit',
      account: { id: 'user-123', email: 'user@example.com', name: 'Test User' },
      token: {
        accessToken: 'access-token-should-not-print',
        refreshToken: 'refresh-token-should-not-print',
        tokenType: 'Bearer',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    })
  );
}

async function startFakeOAuthServer() {
  const requests: Array<{ path: string; body?: string; query?: URLSearchParams }> = [];
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ path: requestUrl.pathname, query: requestUrl.searchParams });
    if (requestUrl.pathname === '/authorize') {
      const redirectUri = requestUrl.searchParams.get('redirect_uri') || '';
      const state = requestUrl.searchParams.get('state') || '';
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', 'fake-code');
      redirectUrl.searchParams.set('state', state);
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/token') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ path: '/token-body', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'access-token-should-not-print',
            refresh_token: 'refresh-token-should-not-print',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile email usage:write',
          })
        );
      });
      return;
    }
    if (requestUrl.pathname === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sub: 'user-123', email: 'user@example.com', name: 'Test User' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fake OAuth server did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startFakeDeviceAuthServer() {
  const requests: Array<{ path: string; body?: string; query?: URLSearchParams }> = [];
  const sessions = new Map<string, { approved: boolean; state: string; userCode: string }>();
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ path: requestUrl.pathname, query: requestUrl.searchParams });
    if (
      requestUrl.pathname === '/api/v1/auth/start' ||
      requestUrl.pathname === '/api/cli-auth/start'
    ) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ path: '/api/cli-auth/start-body', body });
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Fake device server did not bind a port');
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const deviceCode = 'device-code-123';
        const userCode = 'ABCD-EFGH';
        sessions.set(deviceCode, { approved: false, state: 'feishu-state-123', userCode });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            deviceCode,
            userCode,
            verificationUrl: `${baseUrl}/cli-login`,
            verificationUriComplete: `${baseUrl}/cli-login?code=${userCode}&device=${deviceCode}`,
            expiresIn: 60,
            interval: 1,
          })
        );
      });
      return;
    }
    if (requestUrl.pathname === '/cli-login') {
      const deviceCode = requestUrl.searchParams.get('device') || 'device-code-123';
      const session = sessions.get(deviceCode);
      if (!session || requestUrl.searchParams.get('code') !== session.userCode) {
        res.writeHead(404);
        res.end();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Fake device server did not bind a port');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const authorizeUrl = new URL(`${baseUrl}/feishu/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', 'openhermit-debug-feishu-app');
      authorizeUrl.searchParams.set('redirect_uri', `${baseUrl}/api/feishu/callback`);
      authorizeUrl.searchParams.set('scope', 'contact:user.id:readonly');
      authorizeUrl.searchParams.set('state', session.state);
      authorizeUrl.searchParams.set('device', deviceCode);
      res.writeHead(302, { Location: authorizeUrl.toString() });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/feishu/oauth/authorize') {
      const callbackUrl = new URL(
        requestUrl.searchParams.get('redirect_uri') || 'http://127.0.0.1'
      );
      callbackUrl.searchParams.set('code', 'debug-feishu-auth-code-should-not-print');
      callbackUrl.searchParams.set('state', requestUrl.searchParams.get('state') || '');
      callbackUrl.searchParams.set('device', requestUrl.searchParams.get('device') || '');
      res.writeHead(302, { Location: callbackUrl.toString() });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/api/feishu/callback') {
      const deviceCode = requestUrl.searchParams.get('device') || '';
      const session = sessions.get(deviceCode);
      if (!session || requestUrl.searchParams.get('state') !== session.state) {
        res.writeHead(400);
        res.end();
        return;
      }
      session.approved = true;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('feishu approved');
      return;
    }
    if (
      requestUrl.pathname === '/api/v1/auth/poll' ||
      requestUrl.pathname === '/api/cli-auth/token'
    ) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ path: '/api/cli-auth/token-body', body });
        const session = sessions.get('device-code-123');
        res.writeHead(session?.approved ? 200 : 428, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            session?.approved
              ? {
                  accessToken: 'device-access-token-should-not-print',
                  refreshToken: 'device-refresh-token-should-not-print',
                  tokenType: 'Bearer',
                  expiresIn: 3600,
                  scope: 'openid profile email usage:write',
                  account: {
                    id: 'device-union-id-123',
                    email: 'device@example.com',
                    name: 'Device User',
                  },
                }
              : { error: 'authorization_pending' }
          )
        );
      });
      return;
    }
    if (requestUrl.pathname === '/api/v1/auth/refresh') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ path: '/api/v1/auth/refresh-body', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            accessToken: 'refreshed-device-access-token-should-not-print',
            refreshToken: 'refreshed-device-refresh-token-should-not-print',
            tokenType: 'Bearer',
            expiresIn: 3600,
            scope: 'openid profile email usage:write',
            account: {
              id: 'device-union-id-123',
              email: 'refreshed@example.com',
              name: 'Refreshed User',
            },
          })
        );
      });
      return;
    }
    if (requestUrl.pathname === '/api/v1/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ identity: { id: 'device-union-id-123', name: 'Profile User' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fake device auth server did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// These tests spawn the real CLI as child processes; under a full-suite
// parallel run on a loaded Windows machine the default 15s testTimeout is not
// enough (they pass standalone with seconds to spare).
describe('AgentCLI read-only workspace commands', { timeout: 30_000 }, () => {
  it('prints parseable JSON for an empty teams list without starting the web UI', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout, stderr } = await runCli(hermitHome, ['teams', 'list', '--json']);
      const parsed = JSON.parse(stdout);

      expect(stderr).toBe('');
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('teams list');
      expect(parsed.hermitHome).toBe(hermitHome);
      expect(parsed.teams).toEqual([]);
    });
  });

  it('lists teams, skips hidden/deleted teams, and reports malformed manifests as warnings', async () => {
    await withHermitHome(async (hermitHome) => {
      await mkdir(path.join(hermitHome, 'teams/demo'), { recursive: true });
      await mkdir(path.join(hermitHome, 'teams/system-manager'), { recursive: true });
      await mkdir(path.join(hermitHome, 'teams/deleted'), { recursive: true });
      await mkdir(path.join(hermitHome, 'teams/pending-delete'), { recursive: true });
      await mkdir(path.join(hermitHome, 'teams/bad'), { recursive: true });
      await writeFile(
        path.join(hermitHome, 'teams/demo/team.json'),
        JSON.stringify({
          slug: 'demo',
          displayName: 'Demo Team',
          bindProject: 'demo-project',
          harness: 'claudecode',
          workDir: '/tmp/demo',
          updatedAt: '2026-06-21T00:00:00Z',
        })
      );
      await writeFile(
        path.join(hermitHome, 'teams/system-manager/team.json'),
        JSON.stringify({ slug: 'system-manager', displayName: 'System Manager' })
      );
      await writeFile(
        path.join(hermitHome, 'teams/deleted/team.json'),
        JSON.stringify({
          slug: 'deleted',
          displayName: 'Deleted Team',
          deletedAt: '2026-06-21T00:00:00Z',
        })
      );
      await writeFile(
        path.join(hermitHome, 'teams/pending-delete/team.json'),
        JSON.stringify({
          slug: 'pending-delete',
          displayName: 'Pending Delete Team',
          pendingDelete: true,
        })
      );
      await writeFile(path.join(hermitHome, 'teams/bad/team.json'), '{bad json');

      const { stdout } = await runCli(hermitHome, ['teams', 'list', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.teams).toHaveLength(1);
      expect(parsed.teams[0]).toMatchObject({
        slug: 'demo',
        displayName: 'Demo Team',
        bindProject: 'demo-project',
        harness: 'claudecode',
      });
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0].path).toContain(path.join('bad', 'team.json'));
    });
  });

  it('normalizes global options before dispatching read-only commands', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout } = await runCli(hermitHome, ['--port', '5999', 'teams', 'list', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('teams list');
      expect(parsed.teams).toEqual([]);
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('does not treat reserved command words in --team values as mutating commands', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout } = await runCli(hermitHome, ['tasks', 'list', '--team', 'update', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('tasks list');
      expect(parsed.team).toBe('update');
      expect(parsed.tasks).toEqual([]);
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('rejects option-looking team values without probing outside the workspace', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout } = await runCli(hermitHome, ['tasks', 'list', '--team', '--port', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.resolvedTeam).toBeNull();
      expect(parsed.tasks).toEqual([]);
      expect(
        parsed.warnings.some(
          (warning: { message: string }) => warning.message === 'Invalid team argument'
        )
      ).toBe(true);
    });
  });

  it('prints structured status JSON', async () => {
    await withHermitHome(async (hermitHome) => {
      let stdout = '';
      try {
        const result = await runCli(hermitHome, ['status', '--json']);
        stdout = result.stdout;
      } catch (err) {
        stdout = (err as { stdout: string }).stdout;
      }
      const parsed = JSON.parse(stdout);

      expect(parsed.command).toBe('status');
      expect(parsed.status.hermitHome).toBe(hermitHome);
      expect(parsed.status).toHaveProperty('running');
    });
  });

  it('prints structured doctor JSON without creating runtime config', async () => {
    await withHermitHome(async (hermitHome) => {
      try {
        await runCli(hermitHome, ['doctor', '--json']);
      } catch (err) {
        const error = err as { stdout: string };
        const parsed = JSON.parse(error.stdout);

        expect(parsed.command).toBe('doctor');
        expect(Array.isArray(parsed.checks)).toBe(true);
        expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
        return;
      }
      throw new Error('Expected doctor to exit non-zero when checks fail');
    });
  });

  it('prints default navigation actions without auth or starting runtime config', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout } = await runCli(hermitHome, ['--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('navigate');
      expect(parsed.defaultAction).toBe('data-sync');
      expect(parsed.actions.map((action: { id: string }) => action.id)).toEqual([
        'data-sync',
        'account',
        'aikey',
        'exit',
      ]);
      expect(parsed.actions.map((action: { id: string }) => action.id)).not.toContain('web');
      expect(
        parsed.actions.find((action: { id: string; label: string }) => action.id === 'data-sync')
          ?.label
      ).toBe('消息总线');
      expect(
        parsed.actions.find(
          (action: { id: string; description: string }) => action.id === 'data-sync'
        )?.description
      ).toContain('消息上报');
      expect(parsed.message).toContain('桌面客户端');
      expect(parsed.message).toContain('消息总线');
      expect(JSON.stringify(parsed.actions)).not.toContain('选择用量来源');
      expect(JSON.stringify(parsed.actions)).not.toContain('开始上报');
      expect(JSON.stringify(parsed.actions)).not.toContain('远端上报');
      expect(JSON.stringify(parsed.actions)).not.toContain('开发解锁');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('creates a team non-interactively without starting runtime config', async () => {
    await withHermitHome(async (hermitHome) => {
      const workDir = path.join(hermitHome, 'work');
      await mkdir(workDir, { recursive: true });

      const { stdout } = await runCli(hermitHome, [
        'teams',
        'create',
        '--name',
        'Demo Team',
        '--bind-project',
        'demo-team',
        '--work-dir',
        workDir,
        '--json',
      ]);
      const parsed = JSON.parse(stdout);
      const manifestPath = path.join(hermitHome, 'teams/demo-team/team.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('teams create');
      expect(parsed.team).toMatchObject({
        slug: 'demo-team',
        displayName: 'Demo Team',
        bindProject: 'demo-team',
        harness: 'claudecode',
        workDir,
      });
      expect(manifest).toMatchObject(parsed.team);
      expect(existsSync(path.join(hermitHome, 'teams/demo-team/messages'))).toBe(true);
      expect(existsSync(path.join(hermitHome, 'teams/demo-team/tasks'))).toBe(true);
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('round-trips created teams through teams list', async () => {
    await withHermitHome(async (hermitHome) => {
      const workDir = path.join(hermitHome, 'work');
      await mkdir(workDir, { recursive: true });
      await runCli(hermitHome, [
        'teams',
        'create',
        '--name',
        'Round Trip',
        '--bind-project',
        'round-trip',
        '--work-dir',
        workDir,
        '--harness',
        'codex',
        '--json',
      ]);

      const { stdout } = await runCli(hermitHome, ['teams', 'list', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.teams).toHaveLength(1);
      expect(parsed.teams[0]).toMatchObject({
        slug: 'round-trip',
        displayName: 'Round Trip',
        bindProject: 'round-trip',
        harness: 'codex',
        workDir,
      });
    });
  });

  it('rejects invalid and duplicate team bindProject values', async () => {
    await withHermitHome(async (hermitHome) => {
      const workDir = path.join(hermitHome, 'work');
      await mkdir(workDir, { recursive: true });

      await expect(
        runCli(hermitHome, [
          'teams',
          'create',
          '--name',
          'Bad Team',
          '--bind-project',
          'Bad Team!',
          '--work-dir',
          workDir,
          '--json',
        ])
      ).rejects.toMatchObject({ stdout: expect.stringContaining('bindProject must match') });
      expect(existsSync(path.join(hermitHome, 'teams/Bad Team!'))).toBe(false);

      await runCli(hermitHome, [
        'teams',
        'create',
        '--name',
        'Demo Team',
        '--bind-project',
        'demo-team',
        '--work-dir',
        workDir,
        '--json',
      ]);
      await expect(
        runCli(hermitHome, [
          'teams',
          'create',
          '--name',
          'Duplicate Team',
          '--bind-project',
          'demo-team',
          '--work-dir',
          workDir,
          '--json',
        ])
      ).rejects.toMatchObject({ stdout: expect.stringContaining('already exists') });
    });
  });

  it('fails cleanly when required create fields are missing in non-interactive mode', async () => {
    await withHermitHome(async (hermitHome) => {
      await expect(runCli(hermitHome, ['teams', 'create', '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('Missing required --name'),
      });
      expect(existsSync(path.join(hermitHome, 'teams'))).toBe(false);
    });
  });

  it('rejects incomplete auth commands as JSON without starting runtime config', async () => {
    await withHermitHome(async (hermitHome) => {
      await expect(runCli(hermitHome, ['auth', '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('Unknown command: auth'),
      });
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('allows local read-only commands without OpenHermit auth', async () => {
    await withHermitHome(async (hermitHome) => {
      const teams = await runCli(hermitHome, ['teams', 'list', '--json']);
      expect(JSON.parse(teams.stdout)).toMatchObject({ ok: true, command: 'teams list' });

      const tasks = await runCli(hermitHome, ['tasks', 'list', '--team', 'demo', '--json']);
      expect(JSON.parse(tasks.stdout)).toMatchObject({
        ok: true,
        command: 'tasks list',
        team: 'demo',
      });

      await expect(runCli(hermitHome, ['tasks', 'list', '--json'])).rejects.toMatchObject({
        stdout: expect.stringContaining('Missing required --team <team>'),
      });

      let statusStdout = '';
      try {
        statusStdout = (await runCli(hermitHome, ['status', '--json'])).stdout;
      } catch (err) {
        statusStdout = (err as { stdout: string }).stdout;
      }
      expect(JSON.parse(statusStdout)).toMatchObject({ command: 'status' });

      let doctorStdout = '';
      try {
        doctorStdout = (await runCli(hermitHome, ['doctor', '--json'])).stdout;
      } catch (err) {
        doctorStdout = (err as { stdout: string }).stdout;
      }
      expect(JSON.parse(doctorStdout)).toMatchObject({ command: 'doctor' });

      expect(`${teams.stdout}${tasks.stdout}${statusStdout}${doctorStdout}`).not.toContain(
        'OpenHermit OAuth login required'
      );
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('runs usage status and today without OpenHermit auth', async () => {
    await withHermitHome(async (hermitHome) => {
      // usage status/today run a real foreground scan of ~/.claude/projects/ when
      // scan=true. Isolate HOME to the temp home so the scan reads an empty projects
      // dir (totalTokens 0) instead of the developer's real sessions — otherwise the
      // assertion is machine-dependent and scans gigabytes of live data under test.
      const status = await runCli(hermitHome, ['--port', '5999', 'usage', 'status', '--json'], {
        HOME: hermitHome,
      });
      const parsedStatus = JSON.parse(status.stdout);

      expect(parsedStatus).toMatchObject({
        ok: true,
        command: 'usage status',
        source: 'claude-jsonl',
        worker: { running: false },
        daemon: { running: false },
      });
      expect(parsedStatus.telemetry.totalTokens).toBe(0);
      expect(status.stderr).toBe('');

      // 查看同步状态 must be a read-only preview: it runs the remote
      // /usage/status probe but never uploads — no cursor file, no upload log.
      expect(parsedStatus.remoteUsage).toMatchObject({ authorized: false });
      expect(
        existsSync(path.join(hermitHome, 'telemetry', 'conversation-message-scan-cursor.json'))
      ).toBe(false);
      const uploadLogPath = path.join(hermitHome, 'telemetry', 'conversation-upload.log');
      const uploadLog = existsSync(uploadLogPath) ? await readFile(uploadLogPath, 'utf-8') : '';
      expect(uploadLog).not.toContain('upload-request');

      const today = await runCli(hermitHome, ['--port', '5999', 'usage', 'today', '--json'], {
        HOME: hermitHome,
      });
      const parsedToday = JSON.parse(today.stdout);
      expect(parsedToday).toMatchObject({
        ok: true,
        command: 'usage today',
        source: 'claude-jsonl',
        worker: { running: false },
        daemon: { running: false },
      });
      expect(parsedToday.today.totalTokens).toBe(0);
      expect(`${status.stdout}${today.stdout}`).not.toContain('OpenHermit OAuth login required');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('starts and stops the lightweight usage worker without OpenHermit auth', async () => {
    await withHermitHome(async (hermitHome) => {
      const started = await runCli(
        hermitHome,
        ['--port', '5999', 'usage', 'start', '--no-autostart', '--json'],
        { OPENHERMIT_USAGE_WORKER_MODE: 'test', OPENHERMIT_SKIP_LAUNCHCTL: '1' }
      );
      const parsedStart = JSON.parse(started.stdout);
      expect(parsedStart).toMatchObject({
        ok: true,
        command: 'usage start',
        worker: { started: true, mode: 'test' },
        daemon: { running: false },
        telemetry: { localScanEnabled: true, source: 'claude-jsonl' },
        auth: { authorized: false },
      });
      expect(parsedStart.worker.statusPath).toContain(hermitHome);
      expect(started.stderr).toBe('');
      expect(existsSync(path.join(hermitHome, 'telemetry/status.json'))).toBe(true);
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);

      const stopped = await runCli(hermitHome, ['usage', 'stop', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
      const parsedStop = JSON.parse(stopped.stdout);
      expect(parsedStop).toMatchObject({ ok: true, command: 'usage stop' });
      expect(parsedStop.telemetry.localScanEnabled).toBe(false);

      const reconciled = await runCli(hermitHome, ['usage', 'reconcile', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
      expect(JSON.parse(reconciled.stdout)).toMatchObject({
        ok: true,
        command: 'usage reconcile',
        reconciled: true,
      });
      // 用量上报默认开启：reconcile 会把 worker 恢复到期望的运行状态
      expect(existsSync(path.join(hermitHome, 'telemetry/worker.pid'))).toBe(true);
    });
  });

  it('enables Codex as an upload provider instead of treating it as a disabled placeholder', async () => {
    await withHermitHome(async (hermitHome) => {
      const started = await runCli(
        hermitHome,
        [
          '--port',
          '5999',
          'usage',
          'start',
          '--upload',
          '--provider',
          'codex',
          '--no-autostart',
          '--json',
        ],
        { OPENHERMIT_USAGE_WORKER_MODE: 'test', OPENHERMIT_SKIP_LAUNCHCTL: '1' }
      );
      const parsedStart = JSON.parse(started.stdout);
      const settings = JSON.parse(await readFile(path.join(hermitHome, 'settings.json'), 'utf-8'));

      expect(parsedStart).toMatchObject({ ok: true, command: 'usage start' });
      expect(settings.taskBus.telemetry).toMatchObject({
        enabled: true,
        platform: 'codex',
        uploadProviders: ['codex'],
        conversationUploadEnabled: true,
        conversations: { uploadEnabled: true },
      });

      await runCli(hermitHome, ['usage', 'stop', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
    });
  });

  it('enables Claude Code message upload when selected as the CLI upload provider', async () => {
    await withHermitHome(async (hermitHome) => {
      const started = await runCli(
        hermitHome,
        [
          '--port',
          '5999',
          'usage',
          'start',
          '--upload',
          '--provider',
          'claudecode',
          '--no-autostart',
          '--json',
        ],
        { OPENHERMIT_USAGE_WORKER_MODE: 'test', OPENHERMIT_SKIP_LAUNCHCTL: '1' }
      );
      const parsedStart = JSON.parse(started.stdout);
      const settings = JSON.parse(await readFile(path.join(hermitHome, 'settings.json'), 'utf-8'));

      expect(parsedStart).toMatchObject({ ok: true, command: 'usage start' });
      expect(settings.taskBus.telemetry).toMatchObject({
        enabled: true,
        platform: 'claudecode',
        uploadProviders: ['claudecode'],
        conversationUploadEnabled: true,
        conversations: { uploadEnabled: true },
      });

      await runCli(hermitHome, ['usage', 'stop', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
    });
  });

  it('enables multiple message upload providers when selected together', async () => {
    await withHermitHome(async (hermitHome) => {
      const started = await runCli(
        hermitHome,
        [
          '--port',
          '5999',
          'usage',
          'start',
          '--upload',
          '--provider',
          'claudecode,codex',
          '--no-autostart',
          '--json',
        ],
        { OPENHERMIT_USAGE_WORKER_MODE: 'test', OPENHERMIT_SKIP_LAUNCHCTL: '1' }
      );
      const parsedStart = JSON.parse(started.stdout);
      const settings = JSON.parse(await readFile(path.join(hermitHome, 'settings.json'), 'utf-8'));

      expect(parsedStart).toMatchObject({ ok: true, command: 'usage start' });
      expect(settings.taskBus.telemetry).toMatchObject({
        enabled: true,
        platform: 'claudecode',
        uploadProviders: ['claudecode', 'codex'],
        conversationUploadEnabled: true,
        conversations: { uploadEnabled: true },
      });

      await runCli(hermitHome, ['usage', 'stop', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'manages usage worker autostart with a launchd plist that supervises the foreground worker (macOS launchd only)',
    async () => {
      await withHermitHome(async (hermitHome) => {
        const enabled = await runCli(hermitHome, ['usage', 'autostart', 'enable', '--json'], {
          HOME: hermitHome,
          OPENHERMIT_SKIP_LAUNCHCTL: '1',
        });
        const parsedEnabled = JSON.parse(enabled.stdout);
        const plistPath = path.join(
          hermitHome,
          'Library/LaunchAgents/com.openhermit.telemetry.plist'
        );
        const plist = await readFile(plistPath, 'utf-8');

        expect(parsedEnabled).toMatchObject({
          ok: true,
          command: 'usage autostart enable',
          autostart: { enabled: true, label: 'com.openhermit.telemetry' },
        });
        expect(plist).toContain('__telemetry-worker');
        expect(plist).toContain(hermitHome);
        expect(plist).not.toContain('--daemon');

        const disabled = await runCli(hermitHome, ['usage', 'autostart', 'disable', '--json'], {
          HOME: hermitHome,
          OPENHERMIT_SKIP_LAUNCHCTL: '1',
        });
        const parsedDisabled = JSON.parse(disabled.stdout);
        expect(parsedDisabled).toMatchObject({
          ok: true,
          command: 'usage autostart disable',
          autostart: { enabled: false },
        });
      });
    }
  );

  it('runs usage report without auth when message upload is disabled', async () => {
    await withHermitHome(async (hermitHome) => {
      // Conversation upload is DEFAULT-ON for fresh installs (see uploadState.mjs),
      // so seed an explicit opt-out to exercise the "upload disabled" path.
      await writeFile(
        path.join(hermitHome, 'settings.json'),
        JSON.stringify({
          taskBus: {
            telemetry: {
              conversationUploadEnabled: false,
              conversations: { uploadEnabled: false },
            },
          },
        })
      );
      const report = await runCli(hermitHome, ['--port', '5999', 'usage', 'report', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
      const parsedReport = JSON.parse(report.stdout);

      expect(parsedReport).toMatchObject({
        ok: true,
        command: 'usage report',
        localOnly: false,
        upload: { enabled: false, authorized: false },
        daemon: { running: false },
      });
      expect(parsedReport.worker.running).toBe(false);
      expect(report.stderr).toBe('');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('runs usage report without login on a fresh install because message upload defaults off', async () => {
    await withHermitHome(async (hermitHome) => {
      const report = await runCli(hermitHome, ['--port', '5999', 'usage', 'report', '--json'], {
        OPENHERMIT_USAGE_WORKER_MODE: 'test',
        OPENHERMIT_SKIP_LAUNCHCTL: '1',
      });
      const parsed = JSON.parse(report.stdout);

      expect(parsed).toMatchObject({
        ok: true,
        command: 'usage report',
        upload: { enabled: false, authorized: false },
        daemon: { running: false },
      });
      expect(report.stderr).toBe('');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('hides Web service actions from the menu but keeps direct local commands compatible', async () => {
    await withHermitHome(async (hermitHome) => {
      const menu = await runCli(hermitHome, ['--port', '5999', 'services', '--json']);
      const parsedMenu = JSON.parse(menu.stdout);
      expect(parsedMenu).toMatchObject({
        ok: true,
        command: 'services status',
        usage: { enabled: false },
        collaboration: { enabled: false },
        auth: { authorized: false },
      });
      expect(typeof parsedMenu.web.running).toBe('boolean');
      expect(parsedMenu.actions.map((action: { id: string }) => action.id)).not.toEqual(
        expect.arrayContaining(['start-local', 'start-web', 'stop-web'])
      );
      expect(parsedMenu.actions.map((action: { id: string }) => action.id)).not.toContain(
        'start-usage-upload'
      );

      const started = await runCli(
        hermitHome,
        ['--port', '5999', 'services', 'start', 'local', '--json'],
        {
          HOME: hermitHome,
          OPENHERMIT_USAGE_WORKER_MODE: 'test',
          OPENHERMIT_SERVICE_WEB_MODE: 'test',
          OPENHERMIT_SKIP_LAUNCHCTL: '1',
        }
      );
      const parsedStart = JSON.parse(started.stdout);
      const settings = JSON.parse(await readFile(path.join(hermitHome, 'settings.json'), 'utf-8'));

      expect(parsedStart).toMatchObject({
        ok: true,
        command: 'services start local',
        usage: { enabled: true, worker: { mode: 'test' } },
        collaboration: { enabled: true, collaboration: true },
        auth: { authorized: false },
      });
      expect(settings.taskBus).toMatchObject({
        enabled: true,
        collaboration: true,
        telemetry: { enabled: true, platform: 'claudecode' },
      });
      expect(existsSync(path.join(hermitHome, 'telemetry/status.json'))).toBe(true);
      expect(started.stdout).not.toContain('OpenHermit OAuth login required');
    });
  });

  it('starts local collaboration without auth', async () => {
    await withHermitHome(async (hermitHome) => {
      const started = await runCli(hermitHome, ['collaboration', 'start', '--json']);
      const parsed = JSON.parse(started.stdout);
      const settings = JSON.parse(await readFile(path.join(hermitHome, 'settings.json'), 'utf-8'));

      expect(started.stderr).toBe('');
      expect(parsed).toMatchObject({
        ok: true,
        command: 'collaboration start',
        taskBus: {
          enabled: true,
          collaboration: true,
          redis: { host: '127.0.0.1', port: 6379 },
          telemetry: { enabled: true, platform: 'claudecode' },
        },
        auth: { authorized: false },
      });
      expect(settings.taskBus).toMatchObject({
        enabled: true,
        collaboration: true,
        telemetry: { enabled: true, platform: 'claudecode' },
      });
      expect(started.stdout).not.toContain('OpenHermit OAuth login required');
      expect(existsSync(path.join(hermitHome, 'auth/openhermit.json'))).toBe(false);
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('keeps dev unlock hidden and disabled unless the owner supplies a secret', async () => {
    await withHermitHome(async (hermitHome) => {
      const failed = await execFileAsync(
        process.execPath,
        [cliPath, 'auth', 'dev-login', 'wrong', '--json'],
        {
          cwd: repoRoot,
          env: { ...process.env, HERMIT_HOME: hermitHome },
        }
      ).catch((error: { stdout: string; stderr: string }) => error);
      const parsedFailed = JSON.parse(failed.stdout);

      expect(parsedFailed.ok).toBe(false);
      expect(parsedFailed.error).toBe('Invalid dev unlock code');
      expect(existsSync(path.join(hermitHome, 'auth/openhermit.json'))).toBe(false);

      const { stdout, stderr } = await runCli(
        hermitHome,
        ['auth', 'dev-login', 'owner-secret', '--json'],
        { OPENHERMIT_DEV_UNLOCK_CODE: 'owner-secret' }
      );
      const parsed = JSON.parse(stdout);
      const authPath = path.join(hermitHome, 'auth/openhermit.json');
      const authFile = JSON.parse(await readFile(authPath, 'utf-8'));

      expect(stderr).toBe('');
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('auth dev-login');
      expect(authFile.provider).toBe('openhermit-dev');
      expect(authFile.token.accessToken).toMatch(/^dev-unlock-/);
      expect(stdout).not.toContain(authFile.token.accessToken);
    });
  });

  it('prints unauthenticated auth status JSON without starting runtime config', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout, stderr } = await runCli(hermitHome, ['auth', 'status', '--json']);
      const parsed = JSON.parse(stdout);

      expect(stderr).toBe('');
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('auth status');
      expect(parsed.auth.authorized).toBe(false);
      expect(parsed.auth.method).toBeNull();
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('prints unauthenticated auth status text as login-required', async () => {
    await withHermitHome(async (hermitHome) => {
      const { stdout } = await runCli(hermitHome, ['auth', 'status']);

      expect(stdout).toContain('本地使用和本地 usage 统计无需登录');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('refreshes an expired local access token before reporting auth status', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeDeviceAuthServer();
      try {
        await mkdir(path.join(hermitHome, 'auth'), { recursive: true });
        const authPath = path.join(hermitHome, 'auth/openhermit.json');
        await writeFile(
          authPath,
          JSON.stringify({
            schemaVersion: 1,
            provider: 'openhermit',
            issuer: oauth.baseUrl,
            clientId: 'openhermit-cli',
            account: { id: 'old-user', name: 'Old User' },
            token: {
              accessToken: 'expired-access-token-should-not-print',
              refreshToken: 'expired-refresh-token-should-not-print',
              tokenType: 'Bearer',
              expiresAt: '2000-01-01T00:00:00.000Z',
            },
          })
        );

        const { stdout, stderr } = await runCli(hermitHome, ['auth', 'status', '--json']);
        const parsed = JSON.parse(stdout);
        const authFile = JSON.parse(await readFile(authPath, 'utf-8'));

        expect(parsed.auth.authorized).toBe(true);
        expect(parsed.auth.expired).toBe(false);
        expect(parsed.auth.account.name).toBe('Profile User');
        expect(authFile.token.accessToken).toBe('refreshed-device-access-token-should-not-print');
        expect(authFile.token.refreshToken).toBe('refreshed-device-refresh-token-should-not-print');
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/refresh')).toBe(
          true
        );
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/me')).toBe(true);
        expect(`${stdout}${stderr}`).not.toContain('expired-access-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('expired-refresh-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain(
          'refreshed-device-access-token-should-not-print'
        );
        expect(`${stdout}${stderr}`).not.toContain(
          'refreshed-device-refresh-token-should-not-print'
        );
      } finally {
        await oauth.close();
      }
    });
  });

  it('reads auth status from the local store without leaking tokens', async () => {
    await withHermitHome(async (hermitHome) => {
      await mkdir(path.join(hermitHome, 'auth'), { recursive: true });
      await writeFile(
        path.join(hermitHome, 'auth/openhermit.json'),
        JSON.stringify({
          schemaVersion: 1,
          provider: 'openhermit',
          account: { id: 'user-123', email: 'user@example.com', name: 'Test User' },
          token: {
            accessToken: 'access-token-should-not-print',
            refreshToken: 'refresh-token-should-not-print',
            tokenType: 'Bearer',
            expiresAt: '2999-01-01T00:00:00.000Z',
          },
        })
      );

      const { stdout, stderr } = await runCli(hermitHome, ['auth', 'status', '--json']);
      const parsed = JSON.parse(stdout);

      expect(parsed.auth.authorized).toBe(true);
      expect(parsed.auth.account.email).toBe('user@example.com');
      expect(`${stdout}${stderr}`).not.toContain('access-token-should-not-print');
      expect(`${stdout}${stderr}`).not.toContain('refresh-token-should-not-print');
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('logs out idempotently and only removes the openHermit auth store', async () => {
    await withHermitHome(async (hermitHome) => {
      await mkdir(path.join(hermitHome, 'auth'), { recursive: true });
      const authPath = path.join(hermitHome, 'auth/openhermit.json');
      await writeFile(authPath, JSON.stringify({ token: { accessToken: 'secret' } }));

      const first = await runCli(hermitHome, ['auth', 'logout', '--json']);
      expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, command: 'auth logout' });
      expect(existsSync(authPath)).toBe(false);

      const second = await runCli(hermitHome, ['auth', 'logout', '--json']);
      expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, command: 'auth logout' });
      expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
    });
  });

  it('completes default device-code login with one auth base URL without printing tokens', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeDeviceAuthServer();
      try {
        const { stdout, stderr } = await runCli(hermitHome, ['auth', 'login', '--json'], {
          OPENHERMIT_AUTH_BASE_URL: oauth.baseUrl,
          OPENHERMIT_AUTH_OPEN_BROWSER: 'fetch',
        });
        const parsed = JSON.parse(stdout);
        const authPath = path.join(hermitHome, 'auth/openhermit.json');
        const authFile = JSON.parse(await readFile(authPath, 'utf-8'));
        const authStat = await stat(authPath);

        expect(parsed.ok).toBe(true);
        expect(parsed.auth.authorized).toBe(true);
        expect(parsed.auth.account.email).toBe('device@example.com');
        expect(authFile.token.accessToken).toBe('device-access-token-should-not-print');
        expect(authFile.token.refreshToken).toBe('device-refresh-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('device-access-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('device-refresh-token-should-not-print');
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/start')).toBe(true);
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/poll')).toBe(true);
        // Windows has no POSIX permission bits; Node reports 0o666 for normal files there.
        expect(authStat.mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
        expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
      } finally {
        await oauth.close();
      }
    });
  });

  it('ignores top-level --control-url for the unauthenticated default entry', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeDeviceAuthServer();
      try {
        const { stdout } = await runCli(
          hermitHome,
          ['--control-url', `${oauth.baseUrl}/`, '--json'],
          {
            OPENHERMIT_AUTH_BASE_URL: 'http://127.0.0.1:9',
            OPENHERMIT_AUTH_OPEN_BROWSER: 'fetch',
          }
        );
        const parsed = JSON.parse(stdout);

        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe('navigate');
        expect(existsSync(path.join(hermitHome, 'auth/openhermit.json'))).toBe(false);
        expect(oauth.requests).toHaveLength(0);
      } finally {
        await oauth.close();
      }
    });
  });

  it('uses auth login --control-url as the openHermit broker without printing tokens', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeDeviceAuthServer();
      try {
        const { stdout, stderr } = await runCli(
          hermitHome,
          ['auth', 'login', '--control-url', `${oauth.baseUrl}/`, '--json'],
          {
            OPENHERMIT_AUTH_BASE_URL: 'http://127.0.0.1:9',
            OPENHERMIT_AUTH_OPEN_BROWSER: 'fetch',
          }
        );
        const parsed = JSON.parse(stdout);
        const authPath = path.join(hermitHome, 'auth/openhermit.json');
        const authFile = JSON.parse(await readFile(authPath, 'utf-8'));

        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe('auth login');
        expect(parsed.auth.authorized).toBe(true);
        expect(authFile.issuer).toBe(oauth.baseUrl);
        expect(`${stdout}${stderr}`).not.toContain('device-access-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('device-refresh-token-should-not-print');
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/start')).toBe(true);
        expect(oauth.requests.some((request) => request.path === '/api/v1/auth/poll')).toBe(true);
      } finally {
        await oauth.close();
      }
    });
  });

  it('describes device auth as Feishu authorization through openHermit', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeDeviceAuthServer();
      try {
        const { stdout, stderr } = await runCli(
          hermitHome,
          ['auth', 'login', '--control-url', oauth.baseUrl],
          { OPENHERMIT_AUTH_OPEN_BROWSER: 'fetch' }
        );

        expect(stdout).toContain('飞书授权');
        expect(stdout).toContain('AgentCLI');
        expect(stdout).toContain('不会保存飞书 app secret');
        expect(`${stdout}${stderr}`).not.toContain('device-access-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('device-refresh-token-should-not-print');
      } finally {
        await oauth.close();
      }
    });
  });

  it('keeps raw OAuth login available through explicit endpoint env vars', async () => {
    await withHermitHome(async (hermitHome) => {
      const oauth = await startFakeOAuthServer();
      try {
        const { stdout, stderr } = await runCli(hermitHome, ['auth', 'login', '--json'], {
          OPENHERMIT_OAUTH_AUTHORIZE_URL: `${oauth.baseUrl}/authorize`,
          OPENHERMIT_OAUTH_TOKEN_URL: `${oauth.baseUrl}/token`,
          OPENHERMIT_OAUTH_USERINFO_URL: `${oauth.baseUrl}/userinfo`,
          OPENHERMIT_OAUTH_OPEN_BROWSER: 'fetch',
        });
        const parsed = JSON.parse(stdout);
        const authPath = path.join(hermitHome, 'auth/openhermit.json');
        const authFile = JSON.parse(await readFile(authPath, 'utf-8'));
        const authStat = await stat(authPath);

        expect(parsed.ok).toBe(true);
        expect(parsed.auth.authorized).toBe(true);
        expect(parsed.auth.account.email).toBe('user@example.com');
        expect(authFile.token.accessToken).toBe('access-token-should-not-print');
        expect(authFile.token.refreshToken).toBe('refresh-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('access-token-should-not-print');
        expect(`${stdout}${stderr}`).not.toContain('refresh-token-should-not-print');
        const authorize = oauth.requests.find((request) => request.path === '/authorize');
        const redirectUri = authorize?.query?.get('redirect_uri') ?? '';
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/openhermit\/callback$/);
        expect(redirectUri).not.toContain('0.0.0.0');
        // Windows has no POSIX permission bits; Node reports 0o666 for normal files there.
        expect(authStat.mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
        expect(existsSync(path.join(hermitHome, 'hermit-bridge'))).toBe(false);
      } finally {
        await oauth.close();
      }
    });
  });

  it('lists active tasks by bindProject alias and maps persisted statuses', async () => {
    await withHermitHome(async (hermitHome) => {
      await mkdir(path.join(hermitHome, 'teams/demo/tasks'), { recursive: true });
      await writeFile(
        path.join(hermitHome, 'teams/demo/team.json'),
        JSON.stringify({ slug: 'demo', displayName: 'Demo Team', bindProject: 'demo-project' })
      );
      await writeFile(
        path.join(hermitHome, 'teams/demo/tasks/board.json'),
        JSON.stringify({
          tasks: [
            { id: 'task-pending-123', title: 'Plan CLI', status: 'todo' },
            { id: 'task-doing-123', title: 'Build CLI', status: 'doing', assignee: 'agent' },
            { id: 'task-done-123', title: 'Verify CLI', status: 'done' },
            {
              id: 'task-deleted-123',
              title: 'Deleted task',
              status: 'todo',
              deletedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );

      const { stdout } = await runCli(hermitHome, [
        'tasks',
        'list',
        '--team',
        'demo-project',
        '--json',
      ]);
      const parsed = JSON.parse(stdout);

      expect(parsed.resolvedTeam).toBe('demo');
      expect(parsed.tasks).toHaveLength(3);
      expect(parsed.tasks.map((task: { status: string }) => task.status)).toEqual([
        'pending',
        'in_progress',
        'completed',
      ]);
      expect(parsed.tasks[1]).toMatchObject({
        displayId: 'task-doi',
        subject: 'Build CLI',
        owner: 'agent',
      });
    });
  });
});

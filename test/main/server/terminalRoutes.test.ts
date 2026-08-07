import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTerminalRoutes } from '../../../src/main/routes/terminalRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const dependencies = {
    assertTrustedBrowserOrigin: vi.fn(),
    getSessionId: vi.fn((sessionKey: string) =>
      sessionKey === 'team-a:member:member-a' ? 'session-from-store' : undefined
    ),
    resolveWorkDir: vi.fn(async () => '/code/team-a'),
    resolveClaudeBinary: vi.fn(async () => '/usr/local/bin/claude'),
    openTerminal: vi.fn(async () => undefined),
  };
  registerTerminalRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('terminal routes', () => {
  it('quotes commands and working directories for Unix and Windows shells', async () => {
    const { app, dependencies } = createHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/terminal/open-external',
      payload: { command: 'pnpm', args: ['test', "it's"], cwd: '/code/my project' },
    });

    expect(response.json()).toEqual({ ok: true });
    expect(dependencies.openTerminal).toHaveBeenCalledWith(
      `cd '/code/my project' && 'pnpm' 'test' 'it'"'"'s'`,
      'cd /d "/code/my project" && "pnpm" "test" "it\'s"'
    );
  });

  it('resumes direct and stored sessions with the resolved Claude binary', async () => {
    const { app, dependencies } = createHarness();

    const direct = await app.inject({
      method: 'POST',
      url: '/api/direct-cli/resume-in-terminal',
      payload: { resumeSessionId: 'session-direct', cwd: '/code/direct' },
    });
    const stored = await app.inject({
      method: 'POST',
      url: '/api/direct-cli/resume-in-terminal',
      payload: { teamName: 'team-a', memberName: 'member-a' },
    });

    expect(direct.json()).toEqual({ ok: true });
    expect(stored.json()).toEqual({ ok: true });
    expect(dependencies.openTerminal).toHaveBeenNthCalledWith(
      1,
      `cd '/code/direct' && '/usr/local/bin/claude' '--resume' 'session-direct'`,
      'cd /d "/code/direct" && "/usr/local/bin/claude" "--resume" "session-direct"'
    );
    expect(dependencies.openTerminal).toHaveBeenNthCalledWith(
      2,
      `cd '/code/team-a' && '/usr/local/bin/claude' '--resume' 'session-from-store'`,
      'cd /d "/code/team-a" && "/usr/local/bin/claude" "--resume" "session-from-store"'
    );
  });

  it('preserves validation, missing-session and origin error status codes', async () => {
    const { app, dependencies } = createHarness();

    const missingCommand = await app.inject({
      method: 'POST',
      url: '/api/terminal/open-external',
      payload: {},
    });
    const missingSession = await app.inject({
      method: 'POST',
      url: '/api/direct-cli/resume-in-terminal',
      payload: { teamName: 'team-a', memberName: 'missing' },
    });
    dependencies.assertTrustedBrowserOrigin.mockImplementationOnce(() => {
      throw new Error('Forbidden origin: https://evil.example');
    });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/terminal/open-external',
      payload: { command: 'pwd' },
    });

    expect(missingCommand.statusCode).toBe(400);
    expect(missingSession.statusCode).toBe(404);
    expect(forbidden.statusCode).toBe(403);
  });
});

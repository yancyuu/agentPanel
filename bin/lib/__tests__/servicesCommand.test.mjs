import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => {
  const mocked = {
    spawn: childProcessMocks.spawn,
    execSync: () => '',
    exec: () => undefined,
    fork: () => undefined,
  };
  return { ...mocked, default: mocked };
});

describe('servicesCommand', () => {
  let tmpHome;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-services-'));
    process.env.HERMIT_HOME = tmpHome;
    process.env.OPENHERMIT_SERVICE_WEB_MODE = 'test';
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.HERMIT_HOME;
    delete process.env.OPENHERMIT_SERVICE_WEB_MODE;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('collects only local Workbench service status', async () => {
    const { collectServicesStatus } = await import('../servicesCommand.mjs');

    const status = await collectServicesStatus();

    expect(status.web.running).toBe(false);
    expect(status.web.url).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    expect(status).not.toHaveProperty('usage');
    expect(status).not.toHaveProperty('collaboration');
    expect(status).not.toHaveProperty('auth');
  });

  it('renders a single local Workbench row', async () => {
    const { servicesStatusRows } = await import('../servicesCommand.mjs');

    expect(servicesStatusRows({ web: { running: false } })).toEqual([
      ['本地工作台', '未运行', 'off'],
    ]);
  });
});

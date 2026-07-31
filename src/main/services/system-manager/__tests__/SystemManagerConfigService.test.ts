import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminWorkDir, SystemManagerConfigService } from '../SystemManagerConfigService';

const PREV_HERMIT_HOME = process.env.HERMIT_HOME;
let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'hermit-admin-cfg-'));
  process.env.HERMIT_HOME = workdir;
});

afterAll(() => {
  if (PREV_HERMIT_HOME === undefined) delete process.env.HERMIT_HOME;
  else process.env.HERMIT_HOME = PREV_HERMIT_HOME;
  void rm(workdir, { recursive: true, force: true });
});

describe('adminWorkDir', () => {
  it('points at HERMIT_HOME so System Manager uses native Claude Code workspace layout', () => {
    expect(adminWorkDir()).toBe(workdir);
  });
});

describe('SystemManagerConfigService.adminInitialized', () => {
  it('round-trips the marker and persists it across instances', async () => {
    const svc = new SystemManagerConfigService();

    expect((await svc.getConfig()).adminInitialized).toBeUndefined();

    await svc.updateConfig({ adminInitialized: true });
    expect((await svc.getConfig()).adminInitialized).toBe(true);

    // A fresh instance reads the same file → marker survives a restart.
    const reopened = new SystemManagerConfigService();
    expect((await reopened.getConfig()).adminInitialized).toBe(true);
  });

  it('keeps the workspace canonical (~/.hermit) and ignores selectedWorkDir patches', async () => {
    const svc = new SystemManagerConfigService();
    await svc.updateConfig({ adminInitialized: true });
    // selectedWorkDir is fixed at the canonical admin workspace; a patch must
    // never move it (the 诊断 is always rooted at ~/.hermit).
    await svc.updateConfig({ selectedWorkDir: '/tmp/should-be-ignored' });

    const config = await svc.getConfig();
    expect(config.selectedWorkDir).toBe(adminWorkDir());
    expect(config.selectedWorkDir).toBe(workdir);
    expect(config.adminInitialized).toBe(true);
  });
});

describe('SystemManagerConfigService.getStatus', () => {
  it('reports the 诊断 identity and the canonical ~/.hermit workspace', async () => {
    const svc = new SystemManagerConfigService();
    const status = await svc.getStatus();
    expect(status.displayName).toBe('诊断');
    expect(status.adminWorkDir).toBe(workdir);
    expect(status.defaultWorkDir).toBe(workdir);
    expect(status.selectedWorkDir).toBe(workdir);
  });
});

describe('SystemManagerConfigService workspace self-heal', () => {
  it('getConfig() normalizes a stale persisted selectedWorkDir to adminWorkDir() and repairs the file', async () => {
    const svc = new SystemManagerConfigService();
    const configPath = path.join(workdir, 'system-manager.json');
    // Seed the exact drift the operator observed: a stale repo path persisted
    // while the canonical workspace is fixed at ~/.hermit.
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        selectedWorkDir: '/Users/yancyyu/code/hermit',
        adminInitialized: true,
      })
    );

    const config = await svc.getConfig();
    expect(config.selectedWorkDir).toBe(adminWorkDir());
    expect(config.selectedWorkDir).toBe(workdir);

    // Self-heal: the misleading persisted value is rewritten on read.
    const healed = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(healed.selectedWorkDir).toBe(workdir);
    expect(healed.adminInitialized).toBe(true);
  });

  it('getConfig() returns adminWorkDir() when selectedWorkDir is missing or empty', async () => {
    const svc = new SystemManagerConfigService();
    const configPath = path.join(workdir, 'system-manager.json');
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, selectedWorkDir: '' }));

    const config = await svc.getConfig();
    expect(config.selectedWorkDir).toBe(workdir);

    const healed = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(healed.selectedWorkDir).toBe(workdir);
  });
});

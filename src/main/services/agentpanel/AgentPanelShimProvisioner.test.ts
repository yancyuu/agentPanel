import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionAgentPanelShim } from './AgentPanelShimProvisioner';

const tempDirs: string[] = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-shim-'));
  tempDirs.push(root);
  const packageRoot = path.join(root, 'package with spaces');
  const hermitHome = path.join(root, '.hermit');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await writeFile(path.join(packageRoot, 'bin', 'agentpanel.mjs'), '#!/usr/bin/env node\n');
  return { packageRoot, hermitHome };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('provisionAgentPanelShim', () => {
  it('creates and idempotently updates a managed Unix shim', async () => {
    const fixture = await createFixture();
    const first = await provisionAgentPanelShim({
      ...fixture,
      version: '1.0.0',
      platform: 'darwin',
      nodeExecutable: '/Applications/AgentPanel Desktop.app/Contents/MacOS/AgentPanel Desktop',
    });
    const second = await provisionAgentPanelShim({
      ...fixture,
      version: '1.0.0',
      platform: 'darwin',
      nodeExecutable: '/Applications/AgentPanel Desktop.app/Contents/MacOS/AgentPanel Desktop',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('unchanged');
    expect(await readFile(first.targetPath, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(await readFile(first.targetPath, 'utf8')).toContain(
      "exec '/Applications/AgentPanel Desktop.app/Contents/MacOS/AgentPanel Desktop'"
    );
    expect((await stat(first.targetPath)).mode & 0o777).toBe(0o755);
    expect(
      JSON.parse(await readFile(path.join(first.binDir, 'agentpanel.workbench.json'), 'utf8'))
    ).toMatchObject({ managedBy: 'hermit-workbench', version: '1.0.0' });
  });

  it('does not overwrite an unmanaged agentpanel file', async () => {
    const fixture = await createFixture();
    const binDir = path.join(fixture.hermitHome, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'agentpanel'), 'user-owned');

    const result = await provisionAgentPanelShim({
      ...fixture,
      version: '1.0.0',
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
    });

    expect(result.commandName).toBe('agentpanel-workbench');
    expect(await readFile(path.join(binDir, 'agentpanel'), 'utf8')).toBe('user-owned');
    expect(await readFile(result.targetPath, 'utf8')).toContain('/usr/bin/node');
  });

  it('creates a Windows command shim', async () => {
    const fixture = await createFixture();
    const result = await provisionAgentPanelShim({
      ...fixture,
      version: '1.0.0',
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\AgentPanel\\AgentPanel.exe',
    });

    expect(result.targetPath).toMatch(/agentpanel\.cmd$/u);
    expect(await readFile(result.targetPath, 'utf8')).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(await readFile(result.targetPath, 'utf8')).toContain('%*');
  });
});

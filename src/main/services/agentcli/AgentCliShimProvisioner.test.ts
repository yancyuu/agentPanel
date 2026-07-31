import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionAgentCliShim } from './AgentCliShimProvisioner';

const tempDirs: string[] = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-shim-'));
  tempDirs.push(root);
  const packageRoot = path.join(root, 'package with spaces');
  const hermitHome = path.join(root, '.hermit');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await writeFile(path.join(packageRoot, 'bin', 'agentcli.mjs'), '#!/usr/bin/env node\n');
  return { packageRoot, hermitHome };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('provisionAgentCliShim', () => {
  it('creates and idempotently updates a managed Unix shim', async () => {
    const fixture = await createFixture();
    const first = await provisionAgentCliShim({
      ...fixture,
      version: '1.0.0',
      platform: 'darwin',
      nodeExecutable: '/Applications/AgentCLI Desktop.app/Contents/MacOS/AgentCLI Desktop',
    });
    const second = await provisionAgentCliShim({
      ...fixture,
      version: '1.0.0',
      platform: 'darwin',
      nodeExecutable: '/Applications/AgentCLI Desktop.app/Contents/MacOS/AgentCLI Desktop',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('unchanged');
    expect(await readFile(first.targetPath, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(await readFile(first.targetPath, 'utf8')).toContain(
      "exec '/Applications/AgentCLI Desktop.app/Contents/MacOS/AgentCLI Desktop'"
    );
    expect((await stat(first.targetPath)).mode & 0o777).toBe(0o755);
    expect(
      JSON.parse(await readFile(path.join(first.binDir, 'agentcli.workbench.json'), 'utf8'))
    ).toMatchObject({ managedBy: 'hermit-workbench', version: '1.0.0' });
  });

  it('does not overwrite an unmanaged agentcli file', async () => {
    const fixture = await createFixture();
    const binDir = path.join(fixture.hermitHome, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'agentcli'), 'user-owned');

    const result = await provisionAgentCliShim({
      ...fixture,
      version: '1.0.0',
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
    });

    expect(result.commandName).toBe('agentcli-workbench');
    expect(await readFile(path.join(binDir, 'agentcli'), 'utf8')).toBe('user-owned');
    expect(await readFile(result.targetPath, 'utf8')).toContain('/usr/bin/node');
  });

  it('creates a Windows command shim', async () => {
    const fixture = await createFixture();
    const result = await provisionAgentCliShim({
      ...fixture,
      version: '1.0.0',
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\AgentCLI\\AgentCLI.exe',
    });

    expect(result.targetPath).toMatch(/agentcli\.cmd$/u);
    expect(await readFile(result.targetPath, 'utf8')).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(await readFile(result.targetPath, 'utf8')).toContain('%*');
  });
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionPiShim } from './PiShimProvisioner';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ packageRoot: string; hermitHome: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-pi-shim-'));
  tempDirs.push(root);
  const packageRoot = path.join(root, 'package with spaces');
  const hermitHome = path.join(root, '.hermit');
  const piEntry = path.join(
    packageRoot,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js'
  );
  await mkdir(path.dirname(piEntry), { recursive: true });
  await writeFile(piEntry, '#!/usr/bin/env node\n');
  return { packageRoot, hermitHome };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('provisionPiShim', () => {
  it('creates an idempotent desktop-managed Pi command', async () => {
    const fixture = await createFixture();
    const options = {
      ...fixture,
      version: '0.80.10',
      platform: 'darwin' as const,
      nodeExecutable: '/Applications/AgentCLI.app/Contents/MacOS/AgentCLI',
    };

    const first = await provisionPiShim(options);
    const second = await provisionPiShim(options);

    expect(first.status).toBe('created');
    expect(second.status).toBe('unchanged');
    expect(await readFile(first.targetPath, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(await readFile(first.targetPath, 'utf8')).toContain('@earendil-works/pi-coding-agent');
    expect((await stat(first.targetPath)).mode & 0o777).toBe(0o755);
  });

  it('does not overwrite an unmanaged Pi command', async () => {
    const fixture = await createFixture();
    const binDir = path.join(fixture.hermitHome, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, 'pi'), 'user-owned');

    await expect(
      provisionPiShim({
        ...fixture,
        version: '0.80.10',
        platform: 'darwin',
        nodeExecutable: '/Applications/AgentCLI.app/Contents/MacOS/AgentCLI',
      })
    ).rejects.toThrow('Pi shim conflict');
    expect(await readFile(path.join(binDir, 'pi'), 'utf8')).toBe('user-owned');
  });
});

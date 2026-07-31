import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionDesktopCommandAliases } from './DesktopCommandAliasProvisioner';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('provisionDesktopCommandAliases', () => {
  it('creates PATH aliases for the desktop-managed AgentCLI and Pi shims', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-command-alias-'));
    tempDirs.push(root);
    const hermitHome = path.join(root, '.hermit');
    const binDir = path.join(hermitHome, 'bin');
    const pathDir = path.join(root, 'path-bin');
    await Promise.all([mkdir(binDir, { recursive: true }), mkdir(pathDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(binDir, 'agentcli'), '#!/bin/sh\n'),
      writeFile(path.join(binDir, 'pi'), '#!/bin/sh\n'),
    ]);

    const results = await provisionDesktopCommandAliases({
      hermitHome,
      platform: 'darwin',
      candidateDirs: [pathDir],
    });

    expect(results.map((result) => result.status)).toEqual(['created', 'created']);
    expect(await readlink(path.join(pathDir, 'agentcli'))).toBe(path.join(binDir, 'agentcli'));
    expect(await readlink(path.join(pathDir, 'pi'))).toBe(path.join(binDir, 'pi'));
  });

  it('creates WindowsApps command wrappers without changing shell configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-command-windows-'));
    tempDirs.push(root);
    const hermitHome = path.join(root, '.hermit');
    const pathDir = path.join(root, 'WindowsApps');
    await mkdir(path.join(hermitHome, 'bin'), { recursive: true });
    await mkdir(pathDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(hermitHome, 'bin', 'agentcli.cmd'), '@echo off\r\n'),
      writeFile(path.join(hermitHome, 'bin', 'pi.cmd'), '@echo off\r\n'),
    ]);

    const results = await provisionDesktopCommandAliases({
      hermitHome,
      platform: 'win32',
      candidateDirs: [pathDir],
    });

    expect(results.map((result) => result.status)).toEqual(['created', 'created']);
    expect(await readFile(path.join(pathDir, 'agentcli.cmd'), 'utf8')).toContain(
      path.join(hermitHome, 'bin', 'agentcli.cmd')
    );
  });

  it('never overwrites an existing user command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-command-conflict-'));
    tempDirs.push(root);
    const hermitHome = path.join(root, '.hermit');
    const pathDir = path.join(root, 'path-bin');
    await mkdir(path.join(hermitHome, 'bin'), { recursive: true });
    await mkdir(pathDir, { recursive: true });
    await writeFile(path.join(pathDir, 'agentcli'), 'user-owned');

    const [agentcli] = await provisionDesktopCommandAliases({
      hermitHome,
      platform: 'darwin',
      candidateDirs: [pathDir],
    });

    expect(agentcli?.status).toBe('conflict');
  });
});

import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceCleanupService } from '../../../../src/main/services/system-manager/WorkspaceCleanupService';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WorkspaceCleanupService', () => {
  it('groups only whitelisted cleanup candidates and keeps project source/config files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-cleanup-'));
    tempDirs.push(root);
    const hermitHome = path.join(root, '.hermit');
    const workspace = path.join(root, 'workspace');
    const tempRoot = path.join(root, 'tmp');
    await mkdir(path.join(hermitHome, 'teams', 'agent-a'), { recursive: true });
    await mkdir(path.join(hermitHome, 'logs'), { recursive: true });
    await mkdir(path.join(workspace, '.vite'), { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    await writeFile(
      path.join(hermitHome, 'teams', 'agent-a', 'team.json'),
      JSON.stringify({ workDir: workspace })
    );
    await writeFile(path.join(workspace, '.vite', 'cache.bin'), 'cache');
    await writeFile(path.join(workspace, 'source.ts'), 'keep');
    await writeFile(path.join(workspace, '.env.bak'), 'keep-secret-config');
    await writeFile(path.join(workspace, '.DS_Store'), 'junk');
    const oldLog = path.join(hermitHome, 'logs', 'old.log');
    await writeFile(oldLog, 'old log');
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await utimes(oldLog, oldDate, oldDate);
    const oldTemp = path.join(tempRoot, 'agentpanel-old');
    await mkdir(oldTemp);
    await writeFile(path.join(oldTemp, 'item.txt'), 'temp');
    await utimes(oldTemp, oldDate, oldDate);
    await symlink(path.join(workspace, 'source.ts'), path.join(workspace, '.cache'));

    const service = new WorkspaceCleanupService({
      hermitHome,
      tempRoot,
      homeDir: root,
    });
    const scan = await service.scan();

    expect(scan.candidates.map((candidate) => candidate.category)).toEqual(
      expect.arrayContaining(['project-cache', 'system-junk', 'old-logs', 'application-temp'])
    );
    expect(scan.candidates.every((candidate) => candidate.selectedByDefault)).toBe(true);
    expect(scan.candidates.some((candidate) => candidate.path.endsWith('source.ts'))).toBe(false);
    expect(scan.candidates.some((candidate) => candidate.path.endsWith('.env.bak'))).toBe(false);
    expect(scan.candidates.some((candidate) => candidate.path.endsWith('.cache'))).toBe(false);
  });

  it('deletes only the server-rescanned selected IDs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-cleanup-delete-'));
    tempDirs.push(root);
    const hermitHome = path.join(root, '.hermit');
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, '.vite'), { recursive: true });
    await writeFile(path.join(workspace, '.vite', 'cache.bin'), 'cache');
    await writeFile(path.join(workspace, 'source.ts'), 'keep');
    const service = new WorkspaceCleanupService({ hermitHome, tempRoot: path.join(root, 'tmp') });
    const scan = await service.scan(workspace);
    const cache = scan.candidates.find((candidate) => candidate.name === '.vite');
    expect(cache).toBeDefined();

    const result = await service.clean([cache!.id, 'untrusted-client-path'], workspace);

    expect(result.removedIds).toEqual([cache!.id]);
    expect(result.failed).toEqual([
      { id: 'untrusted-client-path', error: '项目已变化或不在安全清理范围内' },
    ]);
    expect(await readFile(path.join(workspace, 'source.ts'), 'utf8')).toBe('keep');
    await expect(readFile(path.join(workspace, '.vite', 'cache.bin'), 'utf8')).rejects.toThrow();
  });
});

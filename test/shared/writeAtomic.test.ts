import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeAtomicFile } from '@shared/writeAtomic/index.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-atomic-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

describe('writeAtomicFile', () => {
  it('原子写入并按 mode 收敛权限', async () => {
    const dir = await makeDir();
    const target = path.join(dir, 'a.json');
    await writeAtomicFile(target, '{"ok":true}\n', { mode: 0o600 });

    expect(await fs.readFile(target, 'utf8')).toBe('{"ok":true}\n');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    // 不残留临时文件
    expect(await fs.readdir(dir)).toEqual(['a.json']);
  });

  it('目标被占用（EPERM）时 rm+rename 重试成功', async () => {
    const dir = await makeDir();
    const target = path.join(dir, 'locked.json');
    await fs.writeFile(target, 'old');

    const originalRename = fs.rename;
    let attempts = 0;
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (from, to) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return originalRename(from, to);
      });

    await writeAtomicFile(target, 'new-content');
    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(target, 'utf8')).toBe('new-content');
  });

  it('非 EPERM/EEXIST 错误直接抛出且不写坏目标', async () => {
    const dir = await makeDir();
    const target = path.join(dir, 'protected.json');
    await fs.writeFile(target, 'old');

    const originalRename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      const error = new Error('access denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    await expect(writeAtomicFile(target, 'new-content')).rejects.toThrow('access denied');
    expect(await fs.readFile(target, 'utf8')).toBe('old');
    void originalRename;
  });
});

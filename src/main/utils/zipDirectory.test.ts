import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { zipDirectory } from './zipDirectory';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('zipDirectory', () => {
  it('creates a deflated ZIP while excluding hidden files and symbolic links', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'agentpanel-zip-'));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, 'nested'));
    writeFileSync(path.join(directory, 'nested', 'result.md'), 'approved delivery '.repeat(30));
    writeFileSync(path.join(directory, '.private'), 'not exported');
    symlinkSync(path.join(directory, 'nested', 'result.md'), path.join(directory, 'linked.md'));

    const archive = await zipDirectory(directory);

    expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(archive.includes(Buffer.from('nested/result.md'))).toBe(true);
    expect(archive.includes(Buffer.from('.private'))).toBe(false);
    expect(archive.includes(Buffer.from('linked.md'))).toBe(false);
  });
});

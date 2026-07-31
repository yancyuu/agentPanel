import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CommentReadStateService } from '../../../../src/main/services/team-management/CommentReadStateService';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CommentReadStateService', () => {
  it('persists read comment IDs outside the browser origin', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-comment-read-'));
    tempDirs.push(hermitHome);
    const service = new CommentReadStateService(hermitHome);

    await service.write({
      'team-1/task-a': { readIds: ['comment-1', 'comment-1', 'comment-2'], lastUpdated: 123 },
    });

    await expect(new CommentReadStateService(hermitHome).read()).resolves.toEqual({
      'team-1/task-a': { readIds: ['comment-1', 'comment-2'], lastUpdated: 123 },
    });
    const raw = await readFile(path.join(hermitHome, 'workbench', 'comment-read-state.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it('filters malformed state instead of persisting arbitrary values', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-comment-read-invalid-'));
    tempDirs.push(hermitHome);
    const service = new CommentReadStateService(hermitHome);

    const result = await service.write({
      valid: { readIds: ['comment-1', 42, ''], lastUpdated: 50 },
      invalid: 'not-an-entry',
    });

    expect(result).toEqual({ valid: { readIds: ['comment-1'], lastUpdated: 50 } });
  });
});

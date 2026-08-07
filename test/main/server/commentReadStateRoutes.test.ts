import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCommentReadStateRoutes } from '../../../src/main/routes/commentReadStateRoutes';
import { CommentReadStateService } from '../../../src/main/services/team-management/CommentReadStateService';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('comment read state routes', () => {
  it('writes and reads the stable read state', async () => {
    const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentpanel-comment-read-route-'));
    tempDirs.push(hermitHome);
    const app = Fastify();
    registerCommentReadStateRoutes(app, { service: new CommentReadStateService(hermitHome) });

    const written = await app.inject({
      method: 'PUT',
      url: '/api/workbench/comment-read-state',
      payload: {
        state: {
          'team-1/task-a': { readIds: ['comment-1'], lastUpdated: 123 },
        },
      },
    });
    expect(written.statusCode).toBe(200);

    const read = await app.inject({ method: 'GET', url: '/api/workbench/comment-read-state' });
    expect(read.json()).toEqual({
      state: {
        'team-1/task-a': { readIds: ['comment-1'], lastUpdated: 123 },
      },
    });
    await app.close();
  });
});

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerReviewCompatibilityRoutes } from '../../../src/main/routes/reviewCompatibilityRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('review compatibility routes', () => {
  it('preserves member and task review projection shapes', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerReviewCompatibilityRoutes(app, { now: () => new Date('2026-01-02T03:04:05Z') });

    const agent = await app.inject({
      method: 'GET',
      url: '/api/teams/team-a/review/agent-changes/member-a',
    });
    const task = await app.inject({
      method: 'GET',
      url: '/api/teams/team-a/review/task-changes/task-a',
    });
    const stats = await app.inject({
      method: 'GET',
      url: '/api/teams/team-a/review/change-stats/member-a',
    });
    const file = await app.inject({
      method: 'GET',
      url: '/api/teams/team-a/review/file-content',
    });

    expect(agent.json()).toEqual({
      teamName: 'team-a',
      memberName: 'member-a',
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      computedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(task.json()).toEqual({ changes: [] });
    expect(stats.json()).toEqual({ stats: {} });
    expect(file.json()).toEqual({ content: '' });
  });

  it('preserves global review compatibility responses', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerReviewCompatibilityRoutes(app);

    const expectations: Array<[string, 'GET' | 'POST', unknown]> = [
      ['/api/teams/team-a/review/apply-decisions', 'POST', { ok: true }],
      ['/api/teams/review/check-conflict', 'POST', { conflict: false }],
      ['/api/teams/review/preview-reject', 'POST', { preview: '' }],
      ['/api/teams/review/save-edited-file', 'POST', { ok: true }],
      ['/api/teams/review/decisions/load', 'POST', { decisions: {} }],
      ['/api/teams/review/decisions/save', 'POST', { ok: true }],
      ['/api/teams/review/decisions/clear', 'POST', { ok: true }],
      ['/api/teams/review/git-file-log', 'GET', { log: [] }],
    ];

    for (const [url, method, expected] of expectations) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
    }
  });
});

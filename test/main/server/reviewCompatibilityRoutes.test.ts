import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerReviewCompatibilityRoutes } from '../../../src/main/routes/reviewCompatibilityRoutes';
import type { ReviewDecisionPayload } from '../../../src/main/services/team-management/TeamWorkspaceService';

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
      ['/api/teams/review/git-file-log', 'GET', { log: [] }],
    ];

    for (const [url, method, expected] of expectations) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
    }
  });

  it('returns null on decisions load and ok on save/clear when no store is configured', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerReviewCompatibilityRoutes(app);

    const load = await app.inject({
      method: 'POST',
      url: '/api/teams/review/decisions/load',
      payload: { teamName: 'team-a', scopeKey: 'scope-1' },
    });
    const save = await app.inject({
      method: 'POST',
      url: '/api/teams/review/decisions/save',
      payload: { teamName: 'team-a', scopeKey: 'scope-1', hunkDecisions: {}, fileDecisions: {} },
    });
    const clear = await app.inject({
      method: 'POST',
      url: '/api/teams/review/decisions/clear',
      payload: { teamName: 'team-a', scopeKey: 'scope-1' },
    });

    expect(load.statusCode).toBe(200);
    expect(load.body).toBe('null');
    expect(save.json()).toEqual({ ok: true });
    expect(clear.json()).toEqual({ ok: true });
  });

  it('rejects decisions routes without teamName or scopeKey', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerReviewCompatibilityRoutes(app);

    for (const action of ['load', 'save', 'clear']) {
      const missingAll = await app.inject({
        method: 'POST',
        url: `/api/teams/review/decisions/${action}`,
        payload: {},
      });
      const missingScope = await app.inject({
        method: 'POST',
        url: `/api/teams/review/decisions/${action}`,
        payload: { teamName: 'team-a' },
      });
      for (const response of [missingAll, missingScope]) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ ok: false, error: 'teamName 和 scopeKey 不能为空' });
      }
    }
  });

  it('round-trips decisions save, load and clear through the configured store', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const store = new Map<string, Record<string, ReviewDecisionPayload>>();
    registerReviewCompatibilityRoutes(app, {
      reviewDecisions: {
        readReviewDecisions: async (teamName) => store.get(teamName) ?? {},
        saveReviewDecision: async (teamName, scopeKey, payload) => {
          store.set(teamName, { ...(store.get(teamName) ?? {}), [scopeKey]: payload });
        },
        clearReviewDecision: async (teamName, scopeKey) => {
          const all = { ...(store.get(teamName) ?? {}) };
          delete all[scopeKey];
          store.set(teamName, all);
        },
      },
    });

    const payload = {
      teamName: 'team-a',
      scopeKey: 'scope-1',
      scopeToken: 'token-1',
      hunkDecisions: { 'src/a.ts:0': 'approved' },
      fileDecisions: { 'src/a.ts': 'approved' },
    };
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/teams/review/decisions/save', payload })
      ).json()
    ).toEqual({ ok: true });

    const loaded = await app.inject({
      method: 'POST',
      url: '/api/teams/review/decisions/load',
      payload: { teamName: 'team-a', scopeKey: 'scope-1' },
    });
    expect(loaded.json()).toEqual({
      scopeToken: 'token-1',
      hunkDecisions: { 'src/a.ts:0': 'approved' },
      fileDecisions: { 'src/a.ts': 'approved' },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/teams/review/decisions/clear',
          payload: { teamName: 'team-a', scopeKey: 'scope-1' },
        })
      ).json()
    ).toEqual({ ok: true });
    const afterClear = await app.inject({
      method: 'POST',
      url: '/api/teams/review/decisions/load',
      payload: { teamName: 'team-a', scopeKey: 'scope-1' },
    });
    expect(afterClear.body).toBe('null');
  });
});

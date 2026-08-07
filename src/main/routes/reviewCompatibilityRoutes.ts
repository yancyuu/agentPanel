import type { ReviewDecisionPayload } from '../services/team-management/TeamWorkspaceService';
import type { FastifyInstance } from 'fastify';

interface ReviewDecisionStore {
  readReviewDecisions(teamName: string): Promise<Record<string, ReviewDecisionPayload>>;
  saveReviewDecision(
    teamName: string,
    scopeKey: string,
    payload: ReviewDecisionPayload
  ): Promise<void>;
  clearReviewDecision(teamName: string, scopeKey: string): Promise<void>;
}

interface ReviewCompatibilityRouteOptions {
  now?: () => Date;
  /** 代码评审 decisions 持久化（落盘 ~/.hermit/teams/<slug>/review-decisions.json） */
  reviewDecisions?: ReviewDecisionStore;
  reply500?: (error: unknown) => { ok: boolean; error: string };
}

export function registerReviewCompatibilityRoutes(
  app: FastifyInstance,
  {
    now = () => new Date(),
    reviewDecisions,
    reply500 = (error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  }: ReviewCompatibilityRouteOptions = {}
): void {
  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/review/agent-changes/:memberName',
    async (request) => ({
      teamName: request.params.name,
      memberName: request.params.memberName,
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      computedAt: now().toISOString(),
    })
  );
  app.get<{ Params: { name: string; taskId: string } }>(
    '/api/teams/:name/review/task-changes/:taskId',
    async () => ({ changes: [] })
  );
  app.get<{ Params: { name: string; memberName: string } }>(
    '/api/teams/:name/review/change-stats/:memberName',
    async () => ({ stats: {} })
  );
  app.get<{ Params: { name: string } }>('/api/teams/:name/review/file-content', async () => ({
    content: '',
  }));
  app.post<{ Params: { name: string } }>('/api/teams/:name/review/apply-decisions', async () => ({
    ok: true,
  }));
  app.post('/api/teams/review/check-conflict', async () => ({ conflict: false }));
  app.post('/api/teams/review/preview-reject', async () => ({ preview: '' }));
  app.post('/api/teams/review/save-edited-file', async () => ({ ok: true }));
  // 代码评审 decisions 持久化 — 按 {teamName, scopeKey} 存取（review-decisions.json）
  // load 直接返回存的 payload（或 null），与前端 loadDecisions 期望的响应形状一致
  app.post<{ Body: { teamName?: string; scopeKey?: string; scopeToken?: string } }>(
    '/api/teams/review/decisions/load',
    async (request, reply) => {
      const { teamName, scopeKey } = request.body ?? {};
      if (!teamName || !scopeKey) {
        return reply.code(400).send({ ok: false, error: 'teamName 和 scopeKey 不能为空' });
      }
      if (!reviewDecisions) return null;
      try {
        const all = await reviewDecisions.readReviewDecisions(teamName);
        return all[scopeKey] ?? null;
      } catch (error) {
        return reply.code(500).send(reply500(error));
      }
    }
  );
  app.post<{
    Body: {
      teamName?: string;
      scopeKey?: string;
      scopeToken?: string;
      hunkDecisions?: Record<string, unknown>;
      fileDecisions?: Record<string, unknown>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
    };
  }>('/api/teams/review/decisions/save', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.teamName || !body.scopeKey) {
      return reply.code(400).send({ ok: false, error: 'teamName 和 scopeKey 不能为空' });
    }
    if (!reviewDecisions) return { ok: true };
    try {
      await reviewDecisions.saveReviewDecision(body.teamName, body.scopeKey, {
        scopeToken: body.scopeToken,
        hunkDecisions: body.hunkDecisions ?? {},
        fileDecisions: body.fileDecisions ?? {},
        ...(body.hunkContextHashesByFile
          ? { hunkContextHashesByFile: body.hunkContextHashesByFile }
          : {}),
      });
      return { ok: true };
    } catch (error) {
      return reply.code(500).send(reply500(error));
    }
  });
  app.post<{ Body: { teamName?: string; scopeKey?: string; scopeToken?: string } }>(
    '/api/teams/review/decisions/clear',
    async (request, reply) => {
      const { teamName, scopeKey } = request.body ?? {};
      if (!teamName || !scopeKey) {
        return reply.code(400).send({ ok: false, error: 'teamName 和 scopeKey 不能为空' });
      }
      if (!reviewDecisions) return { ok: true };
      try {
        await reviewDecisions.clearReviewDecision(teamName, scopeKey);
        return { ok: true };
      } catch (error) {
        return reply.code(500).send(reply500(error));
      }
    }
  );
  app.get('/api/teams/review/git-file-log', async () => ({ log: [] }));
}

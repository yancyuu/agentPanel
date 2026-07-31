import fs from 'node:fs/promises';

import { WORKBENCH_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import type { ServerRuntimeState } from '../serverContext';
import type { ToolApprovalSettings } from '@shared/types/team';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

interface ToolApprovalRouteDependencies {
  state: ServerRuntimeState;
  respondPermission(
    sessionKey: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>
  ): void;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

export function registerToolApprovalRoutes(
  app: FastifyInstance,
  { state, respondPermission, logger }: ToolApprovalRouteDependencies
): void {
  const readSettings = (teamName: string): ToolApprovalSettings =>
    state.toolApprovalSettingsByName.get(teamName) ?? WORKBENCH_TOOL_APPROVAL_SETTINGS;

  app.post<{
    Params: { name: string };
    Body: { runId?: unknown; requestId?: unknown; allow?: unknown; message?: unknown };
  }>('/api/teams/:name/tool-approval/respond', async (request, reply) => {
    const teamName = request.params.name;
    const requestId = typeof request.body?.requestId === 'string' ? request.body.requestId : '';
    const allow = request.body?.allow === true;
    const message =
      typeof request.body?.message === 'string' && request.body.message.trim()
        ? request.body.message
        : undefined;
    if (!requestId) return reply.code(400).send({ ok: false, error: 'requestId required' });
    const pending = state.permissionSessionByRequestId.get(requestId);
    const sessionKey = pending?.sessionKey ?? `${teamName}:lead`;
    let updatedInput: Record<string, unknown> | undefined;
    if (allow && message && pending?.toolName === 'AskUserQuestion') {
      const toolInput = pending.toolInput ?? {};
      try {
        updatedInput = { ...toolInput, answers: JSON.parse(message) as Record<string, string> };
      } catch {
        const questions = (toolInput.questions as { question?: string }[] | undefined) ?? [];
        const answers: Record<string, string> = {};
        if (questions[0]?.question) answers[questions[0].question] = message;
        updatedInput = { ...toolInput, answers };
      }
    }
    try {
      respondPermission(sessionKey, requestId, allow, message, updatedInput);
    } catch (error) {
      logger.warn({ err: error, sessionKey, requestId }, 'tool-approval respond failed');
    }
    state.permissionSessionByRequestId.delete(requestId);
    return { ok: true };
  });

  app.post<{ Params: { name: string }; Body: Partial<ToolApprovalSettings> }>(
    '/api/teams/:name/tool-approval/settings',
    async (request) => {
      const teamName = request.params.name;
      const incoming = request.body ?? {};
      const previous = readSettings(teamName);
      state.toolApprovalSettingsByName.set(teamName, {
        autoAllowAll: incoming.autoAllowAll ?? previous.autoAllowAll,
        autoAllowFileEdits: incoming.autoAllowFileEdits ?? previous.autoAllowFileEdits,
        autoAllowSafeBash: incoming.autoAllowSafeBash ?? previous.autoAllowSafeBash,
        timeoutAction: incoming.timeoutAction ?? previous.timeoutAction,
        timeoutSeconds: incoming.timeoutSeconds ?? previous.timeoutSeconds,
      });
      return { ok: true };
    }
  );

  app.post<{ Body: { filePath?: unknown } }>(
    '/api/teams/tool-approval/read-file',
    async (request) => {
      const filePath = typeof request.body?.filePath === 'string' ? request.body.filePath : '';
      if (!filePath) return { content: '' };
      try {
        return { content: await fs.readFile(filePath, 'utf8') };
      } catch {
        return { content: '' };
      }
    }
  );

  app.post('/api/teams/validate-cli-args', async () => ({ valid: true, args: [], errors: [] }));
}

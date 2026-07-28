import type { FastifyInstance } from 'fastify';

import {
  type ConversationTelemetryService,
  shouldIncludeContent,
} from '../services/session-intelligence/ConversationTelemetryService';

interface ConversationTelemetryRouteDependencies {
  conversationTelemetry: ConversationTelemetryService;
}

export function registerConversationTelemetryRoutes(
  app: FastifyInstance,
  { conversationTelemetry }: ConversationTelemetryRouteDependencies
): void {
  app.get<{
    Querystring: {
      teamName?: string;
      platform?: string;
      from?: string;
      to?: string;
      identityType?: 'person' | 'group' | 'unknown';
      identityId?: string;
      includeContent?: 'none' | 'summary' | 'full' | string;
      includeToolResults?: string;
      includeSystemMessages?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/telemetry/conversations', async (request, reply) => {
    try {
      return await conversationTelemetry.getConversations({
        teamName: request.query.teamName,
        platform: request.query.platform,
        from: request.query.from,
        to: request.query.to,
        identityType: request.query.identityType,
        identityId: request.query.identityId,
        includeContent: shouldIncludeContent(request.query.includeContent),
        includeToolResults: request.query.includeToolResults !== 'false',
        includeSystemMessages: request.query.includeSystemMessages !== 'false',
        limit: request.query.limit ? Number(request.query.limit) : undefined,
        offset: request.query.offset ? Number(request.query.offset) : undefined,
      });
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  app.get<{
    Querystring: {
      format?: 'csv' | 'json' | 'markdown' | 'plaintext' | string;
      teamName?: string;
      platform?: string;
      from?: string;
      to?: string;
      identityType?: 'person' | 'group' | 'unknown';
      identityId?: string;
      includeContent?: 'none' | 'summary' | 'full' | string;
      includeToolResults?: string;
      includeSystemMessages?: string;
    };
  }>('/api/telemetry/conversations/export', async (request, reply) => {
    try {
      const requestedFormat = request.query.format;
      const format =
        requestedFormat === 'json' ||
        requestedFormat === 'markdown' ||
        requestedFormat === 'plaintext' ||
        requestedFormat === 'csv'
          ? requestedFormat
          : 'csv';
      return await conversationTelemetry.exportConversations(format, {
        teamName: request.query.teamName,
        platform: request.query.platform,
        from: request.query.from,
        to: request.query.to,
        identityType: request.query.identityType,
        identityId: request.query.identityId,
        includeContent: shouldIncludeContent(request.query.includeContent),
        includeToolResults: request.query.includeToolResults !== 'false',
        includeSystemMessages: request.query.includeSystemMessages !== 'false',
      });
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { teamName?: string; platform?: string };
  }>('/api/telemetry/conversations/:sessionId', async (request, reply) => {
    try {
      const result = await conversationTelemetry.getConversationDetail(request.params.sessionId, {
        ...request.query,
        includeContent: 'full',
      });
      if (!result) return reply.code(404).send({ error: 'Conversation not found' });
      return result;
    } catch (error) {
      return reply.code(500).send({ error: String(error) });
    }
  });
}

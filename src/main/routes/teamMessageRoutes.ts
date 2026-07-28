import { buildDirectReplyMessageId } from '../services/direct-cli/directCliMessageId';

import type {
  AppendGroupMessageInput,
  GroupMessage,
} from '../services/team-management/TeamWorkspaceService';
import type { HermitBridgeSessionListItem } from '@shared/types/hermitBridge';
import type { AttachmentFileData, AttachmentMeta, AttachmentPayload } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

interface DirectCliMessageInput {
  teamName: string;
  sessionKey: string;
  workDir: string;
  from: string;
  to: string;
  text: string;
  attachments?: AttachmentPayload[];
  messageId: string;
}

interface TeamMessageRouteRegistrationOptions {
  routes?: readonly ('read' | 'process' | 'send')[];
}

interface TeamMessageRouteDependencies {
  readMessages(teamName: string, options: { limit?: number }): Promise<GroupMessage[]>;
  appendMessage(teamName: string, message: AppendGroupMessageInput): Promise<GroupMessage>;
  resolveProjectName(teamName: string): Promise<string>;
  listSessions(projectName: string): Promise<HermitBridgeSessionListItem[]>;
  buildFallbackSessionKey(teamName: string): string;
  sendHarnessMessageViaBridge(params: {
    teamName: string;
    text: string;
    sessionKey?: string;
    msgId?: string;
  }): Promise<string>;
  readEffectiveCcSettings(): Promise<Record<string, unknown>>;
  resolveDirectCliWorkDir(teamName: string): Promise<string>;
  dispatchDirectCliMessage(params: DirectCliMessageInput): Promise<void>;
  broadcastSse(eventName: string, data: unknown): void;
  createMessageId?: () => string;
}

function isAttachmentPayload(value: unknown): value is AttachmentPayload {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Partial<AttachmentPayload>;
  return (
    typeof attachment.id === 'string' &&
    typeof attachment.filename === 'string' &&
    typeof attachment.mimeType === 'string' &&
    typeof attachment.size === 'number' &&
    typeof attachment.data === 'string'
  );
}

function toAttachmentMeta(attachment: AttachmentPayload): AttachmentMeta {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    filePath: attachment.filePath,
  };
}

function toAttachmentFileData(attachment: AttachmentPayload): AttachmentFileData {
  return {
    id: attachment.id,
    data: attachment.data,
    mimeType: attachment.mimeType,
  };
}

function shouldSendAttachmentsToAgent(settings: Record<string, unknown>): boolean {
  return settings.attachment_send !== 'off';
}

function createDefaultMessageId(): string {
  // eslint-disable-next-line sonarjs/pseudo-random -- suffix only avoids local UI collisions; it is not a security token.
  return `hermit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function registerTeamMessageRoutes(
  app: FastifyInstance,
  dependencies: TeamMessageRouteDependencies,
  options: TeamMessageRouteRegistrationOptions = {}
): void {
  const createMessageId = dependencies.createMessageId ?? createDefaultMessageId;
  const routes = new Set(options.routes ?? ['read', 'process', 'send']);

  if (routes.has('read')) {
    app.get<{ Params: { name: string; messageId: string } }>(
      '/api/teams/:name/messages/:messageId/attachments',
      async (request) => {
        const messages = await dependencies.readMessages(request.params.name, { limit: 5000 });
        const message = messages.find((entry) => entry.id === request.params.messageId);
        const attachments = Array.isArray(message?.meta?.attachmentData)
          ? (message.meta.attachmentData as AttachmentFileData[])
          : [];
        return attachments.filter(
          (attachment): attachment is AttachmentFileData =>
            typeof attachment?.id === 'string' &&
            typeof attachment.data === 'string' &&
            typeof attachment.mimeType === 'string'
        );
      }
    );

    app.get<{ Params: { name: string }; Querystring: { cursor?: string; limit?: string } }>(
      '/api/teams/:name/messages',
      async (request) => {
        const { name } = request.params;
        const requestedLimit = Number(request.query.limit ?? 50);
        const limit = Math.min(
          Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50),
          100
        );
        const rawCursor = request.query.cursor;
        const offset = Math.max(
          0,
          Number.isFinite(Number(rawCursor)) ? Math.floor(Number(rawCursor)) : 0
        );
        try {
          const bindProject = await dependencies.resolveProjectName(name);
          const messages = await dependencies.readMessages(name, { limit: 5000 });
          const sessions = await dependencies.listSessions(bindProject).catch(() => []);
          const sessionByKey = new Map(sessions.map((session) => [session.session_key, session]));
          const newestFirstMessages = [...messages].reverse();
          const pageSlice = newestFirstMessages.slice(offset, offset + limit);
          const page = pageSlice.map((message) => {
            const explicitSessionKey =
              typeof message.meta?.sessionKey === 'string'
                ? message.meta.sessionKey
                : typeof message.meta?.session_key === 'string'
                  ? message.meta.session_key
                  : undefined;
            const sessionKey = explicitSessionKey ?? dependencies.buildFallbackSessionKey(name);
            const session = sessionKey ? sessionByKey.get(sessionKey) : undefined;
            return {
              messageId: message.id,
              from: message.from,
              to: message.to,
              text: message.content,
              timestamp: message.ts,
              read: true,
              source:
                typeof message.meta?.source === 'string'
                  ? message.meta.source
                  : ((message.role === 'user' ? 'user_sent' : 'inbox') as string),
              taskRefs: Array.isArray(message.meta?.taskRefs) ? message.meta.taskRefs : undefined,
              summary: typeof message.meta?.summary === 'string' ? message.meta.summary : undefined,
              conversationId:
                typeof message.meta?.conversationId === 'string'
                  ? message.meta.conversationId
                  : undefined,
              replyToConversationId:
                typeof message.meta?.replyToConversationId === 'string'
                  ? message.meta.replyToConversationId
                  : undefined,
              attachments: Array.isArray(message.meta?.attachments)
                ? (message.meta.attachments as AttachmentMeta[])
                : undefined,
              session: sessionKey
                ? {
                    id: session?.id,
                    key: sessionKey,
                    platform: session?.platform,
                    title: session?.name || session?.user_name || session?.chat_name || sessionKey,
                    chatName: session?.chat_name,
                    userName: session?.user_name,
                  }
                : undefined,
            };
          });
          const lastMessage = messages[messages.length - 1];
          const firstMessage = messages[0];
          const feedRevision = `${messages.length}:${firstMessage?.id ?? '0'}:${lastMessage?.id ?? '0'}`;
          const nextOffset = offset + page.length;
          const hasMore = nextOffset < newestFirstMessages.length;
          return {
            messages: page,
            nextCursor: hasMore ? String(nextOffset) : null,
            hasMore,
            feedRevision,
          };
        } catch {
          return { messages: [], nextCursor: null, hasMore: false, feedRevision: '0' };
        }
      }
    );
  }

  if (routes.has('process')) {
    app.post<{ Params: { name: string }; Body: { text?: string; message?: string } }>(
      '/api/teams/:name/process-send',
      async (request, reply) => {
        try {
          const text = request.body?.text ?? request.body?.message ?? '';
          if (text) {
            await dependencies.sendHarnessMessageViaBridge({
              teamName: request.params.name,
              text,
            });
          }
          return { ok: true };
        } catch (error) {
          return reply.code(502).send({
            ok: false,
            error: error instanceof Error ? error.message : '发送到 harness 失败',
          });
        }
      }
    );
  }

  if (routes.has('send')) {
    app.post<{
      Params: { name: string };
      Body: {
        member?: string;
        text?: string;
        content?: string;
        summary?: string;
        sessionKey?: string;
        messageId?: string;
        attachments?: unknown;
      };
    }>('/api/teams/:name/send-message', async (request) => {
      const teamName = request.params.name;
      const text = request.body?.text ?? request.body?.content ?? '';
      if (!text.trim()) return { ok: true, messageId: null };

      const requestedMessageId =
        typeof request.body?.messageId === 'string' ? request.body.messageId.trim() : '';
      const messageId = requestedMessageId || createMessageId();
      const requestedSessionKey =
        typeof request.body?.sessionKey === 'string' ? request.body.sessionKey.trim() : '';
      const sessionKey = requestedSessionKey || dependencies.buildFallbackSessionKey(teamName);
      const attachments = Array.isArray(request.body?.attachments)
        ? request.body.attachments.filter(isAttachmentPayload)
        : [];
      const attachmentMeta = attachments.map(toAttachmentMeta);
      const attachmentData = attachments.map(toAttachmentFileData);
      const ccSettings = await dependencies.readEffectiveCcSettings();
      const attachmentsForAgent = shouldSendAttachmentsToAgent(ccSettings) ? attachments : [];

      const userMessage = await dependencies
        .appendMessage(teamName, {
          id: messageId,
          from: 'user',
          to: teamName,
          role: 'user',
          content: text,
          meta: {
            sessionKey,
            attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
            attachmentData: attachmentData.length > 0 ? attachmentData : undefined,
          },
        })
        .catch(() => null);

      dependencies.broadcastSse('team-change', { type: 'inbox', teamName });

      const member = typeof request.body?.member === 'string' ? request.body.member.trim() : '';
      const directSessionKey = `${teamName}:member:${member || 'lead'}`;
      const memberWorkDir = await dependencies.resolveDirectCliWorkDir(teamName).catch(() => '');
      const dispatchedDirect = Boolean(memberWorkDir);
      if (dispatchedDirect) {
        void dependencies
          .dispatchDirectCliMessage({
            teamName,
            sessionKey: directSessionKey,
            workDir: memberWorkDir,
            from: member || teamName,
            to: 'user',
            text,
            attachments: attachmentsForAgent,
            messageId: buildDirectReplyMessageId(directSessionKey),
          })
          .catch((error) => {
            request.log.warn(
              { err: error, teamName, sessionKey: directSessionKey },
              'send-message direct-cli delivery failed'
            );
            dependencies.broadcastSse('team-change', { type: 'inbox', teamName });
          });
      } else {
        request.log.warn({ teamName }, 'send-message direct-cli skipped: no work_dir resolved');
      }

      return {
        ok: true,
        deliveredToInbox: true,
        messageId: userMessage?.id ?? messageId,
        runtimeDelivery: {
          attempted: true,
          delivered: dispatchedDirect,
        },
      };
    });
  }
}

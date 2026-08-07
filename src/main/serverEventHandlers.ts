import { WORKBENCH_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import { shouldAutoAllow } from './utils/toolApprovalRules';

import type { ServerRuntimeState } from './serverContext';
import type { DirectCliEvent } from './services/direct-cli';
import type { TeamProvisioningService } from './services/team-management';
import type { ToolApprovalRequest } from '@shared/types/team';
import type { FastifyBaseLogger } from 'fastify';

type AppendMessagePayload = Parameters<TeamProvisioningService['appendMessage']>[1];
type AppendMessageResult = ReturnType<TeamProvisioningService['appendMessage']>;

interface DirectCliEventSource {
  on(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  off(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  respondPermission(sessionKey: string, requestId: string, allow: boolean): void;
}

interface BridgeEventSource {
  on(
    eventName: 'reply' | 'reply_stream' | 'message',
    listener: (message: unknown) => void
  ): unknown;
  off(
    eventName: 'reply' | 'reply_stream' | 'message',
    listener: (message: unknown) => void
  ): unknown;
}

interface ServerEventHandlerDependencies {
  state: ServerRuntimeState;
  directCliManager: DirectCliEventSource;
  bridge: BridgeEventSource;
  appendMessage(teamName: string, message: AppendMessagePayload): AppendMessageResult;
  resolveTeamFromBridgeMessage(message: unknown): Promise<string | null>;
  broadcastSse(eventName: string, data: unknown): void;
  logger: Pick<FastifyBaseLogger, 'warn'>;
  now?: () => Date;
}

export function registerServerEventHandlers({
  state,
  directCliManager,
  bridge,
  appendMessage,
  resolveTeamFromBridgeMessage,
  broadcastSse,
  logger,
  now = () => new Date(),
}: ServerEventHandlerDependencies): () => void {
  const handleDirectCliEvent = (event: DirectCliEvent) => {
    const route = state.directCliRoutes.get(event.sessionKey);
    if (!route) return;
    const { teamName } = route;
    const eventMessageId = 'messageId' in event ? event.messageId : undefined;
    const conversationId =
      (eventMessageId ? route.conversationIdByMessageId?.[eventMessageId] : undefined) ??
      route.conversationId;

    if (event.kind === 'complete') {
      void (async () => {
        if (event.text) {
          await appendMessage(teamName, {
            // Preserve the streaming message ID so the optimistic renderer row
            // is replaced instead of duplicated when persistence completes.
            id: event.messageId,
            from: route.from,
            to: route.to,
            role: 'agent',
            content: event.text,
            meta: {
              sessionKey: event.sessionKey,
              source: 'direct-cli',
              ...(conversationId
                ? {
                    conversationId,
                    replyToConversationId: conversationId,
                  }
                : {}),
            },
          }).catch((error) =>
            logger.warn({ err: error, sessionKey: event.sessionKey }, 'direct-cli append failed')
          );
        }
        if (eventMessageId && route.conversationIdByMessageId?.[eventMessageId]) {
          const conversationIdByMessageId = { ...route.conversationIdByMessageId };
          delete conversationIdByMessageId[eventMessageId];
          state.directCliRoutes.set(event.sessionKey, {
            ...route,
            conversationIdByMessageId,
          });
        }
        broadcastSse('team-change', { type: 'inbox', teamName });
      })();
      return;
    }

    if (event.kind === 'error') {
      logger.warn({ error: event.error, sessionKey: event.sessionKey }, 'direct-cli session error');
      broadcastSse('team-change', { type: 'inbox', teamName });
      return;
    }

    if (event.kind === 'permission-request') {
      void (async () => {
        const settings =
          state.toolApprovalSettingsByName.get(teamName) ?? WORKBENCH_TOOL_APPROVAL_SETTINGS;
        const autoAllow =
          event.subtype !== 'can_use_tool' ||
          shouldAutoAllow(settings, event.toolName ?? 'Unknown', event.toolInput ?? {}).autoAllow;
        if (autoAllow) {
          try {
            directCliManager.respondPermission(event.sessionKey, event.requestId, true);
          } catch (error) {
            logger.warn(
              { err: error, sessionKey: event.sessionKey },
              'direct-cli auto-allow respond failed'
            );
          }
          return;
        }

        state.permissionSessionByRequestId.set(event.requestId, {
          sessionKey: event.sessionKey,
          toolName: event.toolName,
          toolInput: event.toolInput,
        });
        broadcastSse('tool-approval-event', {
          requestId: event.requestId,
          runId: event.runId,
          teamName,
          source: 'lead',
          toolName: event.toolName ?? 'Unknown',
          toolInput: event.toolInput ?? {},
          receivedAt: now().toISOString(),
        } satisfies ToolApprovalRequest);
      })();
      return;
    }

    broadcastSse('team-change', {
      type: 'direct-cli-stream',
      teamName,
      sessionKey: event.sessionKey,
      messageId: 'messageId' in event ? event.messageId : undefined,
      kind: event.kind,
      text: 'text' in event ? event.text : undefined,
      toolName: 'toolName' in event ? event.toolName : undefined,
      toolInput: 'toolInput' in event ? event.toolInput : undefined,
      from: route.from,
      conversationId,
    });
  };

  const handleBridgeReply = (message: unknown) => {
    const sessionKey = (message as { session_key?: string }).session_key ?? '';

    void (async () => {
      const teamName = await resolveTeamFromBridgeMessage(message);
      if (!teamName) return;
      await appendMessage(teamName, {
        from: teamName,
        to: 'user',
        role: 'agent',
        content: (message as { content?: string }).content ?? '',
        meta: { sessionKey },
      });
      broadcastSse('team-change', { type: 'inbox', teamName });
    })().catch((error) => {
      logger.warn({ err: error, sessionKey }, 'bridge reply persistence failed');
    });
  };

  const handleBridgeReplyStream = (message: unknown) => {
    const sessionKey = (message as { session_key?: string }).session_key ?? '';
    const done = (message as { done?: boolean }).done ?? false;

    // cc-connect can emit a reply_stream event for every generated chunk. The
    // renderer cannot display those chunks yet: a lead-message event only
    // triggers a full message-head fetch, while the canonical message is not
    // persisted until `done`. Resolving the team and refreshing the whole feed
    // for every delta makes Windows input and scrolling noticeably janky.
    if (!done) return;

    void (async () => {
      const teamName = await resolveTeamFromBridgeMessage(message);
      if (!teamName) return;
      const fullText = (message as { full_text?: string }).full_text ?? '';
      if (fullText) {
        await appendMessage(teamName, {
          from: teamName,
          to: 'user',
          role: 'agent',
          content: fullText,
          meta: { sessionKey },
        });
      }
      broadcastSse('team-change', { type: 'inbox', teamName });
    })().catch((error) => {
      logger.warn({ err: error, sessionKey }, 'bridge stream reply persistence failed');
    });
  };

  const handleBridgeMessage = (message: unknown) => {
    const type = (message as { type?: string }).type ?? '';
    const sessionKey = (message as { session_key?: string }).session_key ?? '';
    if (!sessionKey) return;

    void (async () => {
      const teamName = await resolveTeamFromBridgeMessage(message);
      if (!teamName) return;
      const eventType =
        type === 'typing_start' || type === 'typing_stop' ? 'lead-message' : 'inbox';
      broadcastSse('team-change', { type: eventType, teamName });
    })().catch((error) => {
      logger.warn({ err: error, sessionKey, type }, 'bridge message routing failed');
    });
  };

  directCliManager.on('event', handleDirectCliEvent);
  bridge.on('reply', handleBridgeReply);
  bridge.on('reply_stream', handleBridgeReplyStream);
  bridge.on('message', handleBridgeMessage);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    directCliManager.off('event', handleDirectCliEvent);
    bridge.off('reply', handleBridgeReply);
    bridge.off('reply_stream', handleBridgeReplyStream);
    bridge.off('message', handleBridgeMessage);
  };
}

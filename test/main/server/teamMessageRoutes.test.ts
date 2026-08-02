/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamMessageRoutes } from '../../../src/main/routes/teamMessageRoutes';
import type {
  AppendGroupMessageInput,
  GroupMessage,
} from '../../../src/main/services/team-management/TeamWorkspaceService';
import type { HermitBridgeSessionListItem } from '../../../src/shared/types/hermitBridge';
import type { AttachmentPayload } from '../../../src/shared/types/team';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerTeamMessageRoutes>[1];

function groupMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: 'message-1',
    ts: '2026-01-01T00:00:00.000Z',
    from: 'agent',
    to: 'team',
    role: 'agent',
    content: 'hello',
    meta: null,
    ...overrides,
  };
}

function bridgeSession(
  overrides: Partial<HermitBridgeSessionListItem> = {}
): HermitBridgeSessionListItem {
  return {
    id: 'session-id',
    name: 'Session title',
    session_key: 'session-key',
    agent_session_id: undefined,
    agent_type: 'claudecode',
    active: true,
    live: true,
    history_count: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:01.000Z',
    last_message: null,
    platform: 'bridge',
    ...overrides,
  };
}

const validAttachment: AttachmentPayload = {
  id: 'attachment-1',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  size: 5,
  data: 'aGVsbG8=',
  filePath: '/tmp/notes.txt',
};

function createHarness(overrides: Partial<Dependencies> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);

  const dependencies: Dependencies = {
    readMessages: vi.fn(async () => []),
    appendMessage: vi.fn(async (teamName: string, message: AppendGroupMessageInput) =>
      groupMessage({
        id: message.id ?? 'generated-id',
        from: message.from,
        to: message.to ?? teamName,
        role: message.role ?? 'user',
        content: message.content,
        meta: message.meta,
      })
    ),
    resolveProjectName: vi.fn(async () => 'project-a'),
    listSessions: vi.fn(async () => []),
    buildFallbackSessionKey: vi.fn((teamName: string) => `hermit:${teamName}:session`),
    sendHarnessMessageViaBridge: vi.fn(async () => 'hermit:team-a:session'),
    readEffectiveCcSettings: vi.fn(async () => ({})),
    resolveDirectCliWorkDir: vi.fn(async () => '/work/team-a'),
    dispatchDirectCliMessage: vi.fn(async () => undefined),
    broadcastSse: vi.fn(),
    createMessageId: vi.fn(() => 'generated-user-id'),
    ...overrides,
  };

  registerTeamMessageRoutes(app, dependencies);
  return { app, dependencies };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team message routes', () => {
  it('returns only valid stored attachment payloads for one message', async () => {
    const readMessages = vi.fn(async () => [
      groupMessage({
        id: 'target',
        meta: {
          attachmentData: [
            { id: 'a', data: 'base64', mimeType: 'text/plain' },
            { id: 'missing-data', mimeType: 'text/plain' },
            null,
          ],
        },
      }),
    ]);
    const harness = createHarness({ readMessages });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/messages/target/attachments',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'a', data: 'base64', mimeType: 'text/plain' }]);
    expect(readMessages).toHaveBeenCalledWith('team-a', { limit: 5000 });
  });

  it('paginates newest-first, clamps cursor and enriches message/session metadata', async () => {
    const taskRef = { taskId: 'task-1', displayId: 'TASK-1', teamName: 'team-a' };
    const readMessages = vi.fn(async () => [
      groupMessage({
        id: 'oldest',
        ts: '2026-01-01T00:00:00.000Z',
        role: 'user',
        from: 'user',
        content: 'old',
      }),
      groupMessage({
        id: 'middle',
        ts: '2026-01-01T00:00:01.000Z',
        meta: { session_key: 'session-key', source: 'inbox' },
      }),
      groupMessage({
        id: 'suggestion',
        ts: '2026-01-01T00:00:01.500Z',
        meta: { source: 'precipitation_suggestion', conversationId: 'task:task-1' },
      }),
      groupMessage({
        id: 'newest',
        ts: '2026-01-01T00:00:02.000Z',
        meta: {
          sessionKey: 'session-key',
          taskRefs: [taskRef],
          summary: 'summary',
          conversationId: 'conversation-1',
          replyToConversationId: 'conversation-0',
          attachments: [{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 1 }],
        },
      }),
    ]);
    const listSessions = vi.fn(async () => [bridgeSession()]);
    const harness = createHarness({ readMessages, listSessions });

    const firstPage = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/messages?cursor=-10&limit=2.9',
    });
    const secondPage = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/messages?cursor=2&limit=1',
    });

    expect(firstPage.json()).toEqual({
      messages: [
        expect.objectContaining({
          messageId: 'newest',
          taskRefs: [taskRef],
          summary: 'summary',
          conversationId: 'conversation-1',
          replyToConversationId: 'conversation-0',
          attachments: [{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 1 }],
          session: {
            id: 'session-id',
            key: 'session-key',
            platform: 'bridge',
            title: 'Session title',
          },
        }),
        expect.objectContaining({
          messageId: 'suggestion',
          source: 'precipitation_suggestion',
          conversationId: 'task:task-1',
        }),
      ],
      nextCursor: '2',
      hasMore: true,
      feedRevision: '4:oldest:newest',
    });
    expect(secondPage.json()).toEqual({
      messages: [
        expect.objectContaining({
          messageId: 'middle',
          source: 'inbox',
        }),
      ],
      nextCursor: '3',
      hasMore: true,
      feedRevision: '4:oldest:newest',
    });
    expect(listSessions).toHaveBeenCalledWith('project-a');
  });

  it('returns the established empty page when message resolution fails', async () => {
    const harness = createHarness({
      resolveProjectName: vi.fn(async () => {
        throw new Error('missing project');
      }),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/teams/team-a/messages?cursor=bad&limit=bad',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: '0',
    });
  });

  it('preserves process-send empty, bridge delivery, and 502 failure contracts', async () => {
    const sendHarnessMessageViaBridge = vi
      .fn<Dependencies['sendHarnessMessageViaBridge']>()
      .mockResolvedValueOnce('hermit:team-a:session')
      .mockRejectedValueOnce(new Error('bridge offline'));
    const harness = createHarness({ sendHarnessMessageViaBridge });

    const empty = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/process-send',
      payload: {},
    });
    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/process-send',
      payload: { message: 'hello bridge' },
    });
    const failed = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/process-send',
      payload: { text: 'retry' },
    });

    expect(empty.json()).toEqual({ ok: true });
    expect(sent.json()).toEqual({ ok: true });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ ok: false, error: 'bridge offline' });
    expect(sendHarnessMessageViaBridge).toHaveBeenCalledTimes(2);
    expect(sendHarnessMessageViaBridge).toHaveBeenNthCalledWith(1, {
      teamName: 'team-a',
      text: 'hello bridge',
    });
  });

  it('persists and broadcasts before direct dispatch with distinct user and reply ids', async () => {
    const order: string[] = [];
    const appendMessage = vi.fn(async (teamName: string, message: AppendGroupMessageInput) => {
      order.push('persist');
      return groupMessage({
        id: message.id,
        from: message.from,
        to: message.to ?? teamName,
        role: message.role ?? 'user',
        content: message.content,
        meta: message.meta,
      });
    });
    const broadcastSse = vi.fn(() => order.push('broadcast'));
    const dispatchDirectCliMessage = vi.fn<Dependencies['dispatchDirectCliMessage']>(async () => {
      order.push('dispatch');
    });
    const harness = createHarness({ appendMessage, broadcastSse, dispatchDirectCliMessage });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: {
        member: 'alice',
        text: 'please investigate',
        messageId: 'optimistic-user-id',
        sessionKey: 'custom-session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      deliveredToInbox: true,
      messageId: 'optimistic-user-id',
      conversationId: 'optimistic-user-id',
      runtimeDelivery: { attempted: true, delivered: true },
    });
    expect(order).toEqual(['persist', 'broadcast', 'dispatch']);
    expect(appendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        id: 'optimistic-user-id',
        from: 'user',
        to: 'alice',
        role: 'user',
        content: 'please investigate',
        meta: expect.objectContaining({
          sessionKey: 'custom-session',
          conversationId: 'optimistic-user-id',
          source: 'user_sent',
        }),
      })
    );
    expect(appendMessage.mock.calls[0]?.[1]).not.toHaveProperty('isMeta');
    expect(dispatchDirectCliMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        sessionKey: 'custom-session',
        workDir: '/work/team-a',
        from: 'alice',
        to: 'user',
        text: 'please investigate',
      })
    );
    const replyId = dispatchDirectCliMessage.mock.calls[0]?.[0].messageId;
    expect(replyId).toMatch(/^direct-custom-session-/);
    expect(replyId).not.toBe('optimistic-user-id');
    expect(broadcastSse).toHaveBeenCalledWith('team-change', {
      type: 'inbox',
      teamName: 'team-a',
    });
  });

  it('filters malformed attachments, persists valid data, and honors attachment opt-out', async () => {
    const appendMessage = vi.fn(async (_teamName: string, message: AppendGroupMessageInput) =>
      groupMessage({
        id: message.id,
        from: message.from,
        content: message.content,
        meta: message.meta,
      })
    );
    const dispatchDirectCliMessage = vi.fn(async () => undefined);
    const harness = createHarness({
      appendMessage,
      dispatchDirectCliMessage,
      readEffectiveCcSettings: vi.fn(async () => ({ attachment_send: 'off' })),
    });

    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: {
        text: 'with attachment',
        attachments: [validAttachment, { id: 'bad', filename: 'bad.txt' }, null],
      },
    });

    expect(appendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        meta: expect.objectContaining({
          sessionKey: 'team-a:member:lead',
          conversationId: expect.any(String),
          source: 'user_sent',
          attachments: [
            {
              id: 'attachment-1',
              filename: 'notes.txt',
              mimeType: 'text/plain',
              size: 5,
              filePath: '/tmp/notes.txt',
            },
          ],
          attachmentData: [{ id: 'attachment-1', data: 'aGVsbG8=', mimeType: 'text/plain' }],
        }),
      })
    );
    expect(dispatchDirectCliMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] })
    );
  });

  it('passes valid attachments to direct CLI by default', async () => {
    const dispatchDirectCliMessage = vi.fn(async () => undefined);
    const harness = createHarness({ dispatchDirectCliMessage });

    await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: { content: 'send file', attachments: [validAttachment] },
    });

    expect(dispatchDirectCliMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [validAttachment] })
    );
  });

  it('returns immediately while direct dispatch runs in the background and refreshes after failure', async () => {
    let rejectDispatch: ((error: Error) => void) | undefined;
    const dispatchDirectCliMessage = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDispatch = reject;
        })
    );
    const broadcastSse = vi.fn();
    const harness = createHarness({ dispatchDirectCliMessage, broadcastSse });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: { text: 'background turn' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().runtimeDelivery).toEqual({ attempted: true, delivered: true });
    expect(dispatchDirectCliMessage).toHaveBeenCalledOnce();
    expect(broadcastSse).toHaveBeenCalledTimes(1);

    rejectDispatch?.(new Error('direct cli failed'));
    await vi.waitFor(() => expect(broadcastSse).toHaveBeenCalledTimes(2));
  });

  it('degrades append failure to the requested id and reports unavailable direct work dir', async () => {
    const dispatchDirectCliMessage = vi.fn(async () => undefined);
    const harness = createHarness({
      appendMessage: vi.fn(async () => {
        throw new Error('disk full');
      }),
      resolveDirectCliWorkDir: vi.fn(async () => ''),
      dispatchDirectCliMessage,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: { text: 'still acknowledge', messageId: 'client-id' },
    });

    expect(response.json()).toEqual({
      ok: true,
      deliveredToInbox: true,
      messageId: 'client-id',
      conversationId: 'client-id',
      runtimeDelivery: { attempted: true, delivered: false },
    });
    expect(dispatchDirectCliMessage).not.toHaveBeenCalled();
    expect(harness.dependencies.broadcastSse).toHaveBeenCalledOnce();
  });

  it('keeps empty sends as a no-op without persistence or delivery', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/teams/team-a/send-message',
      payload: { text: '   ' },
    });

    expect(response.json()).toEqual({ ok: true, messageId: null });
    expect(harness.dependencies.appendMessage).not.toHaveBeenCalled();
    expect(harness.dependencies.dispatchDirectCliMessage).not.toHaveBeenCalled();
    expect(harness.dependencies.broadcastSse).not.toHaveBeenCalled();
  });
});

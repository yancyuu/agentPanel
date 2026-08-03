import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadConversationMessages, withUploadLock } from '../ConversationMessageUploadService';

describe('ConversationMessageUploadService', () => {
  let tmpDir: string;
  let hermitHome: string;
  let claudeBase: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    delete process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'hermit-upload-test-'));
    hermitHome = path.join(tmpDir, '.hermit');
    claudeBase = path.join(tmpDir, '.claude');
    process.env.HERMIT_HOME = hermitHome;
    process.env.CODEX_HOME = path.join(tmpDir, '.codex');
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmpDir, '.pi', 'agent', 'sessions');
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL = 'http://monitor.test';
    // Default: disable the periodic first-run date filter so the existing fixtures
    // (hard-coded old timestamps, no cursor) still upload. The date-filter test
    // re-enables it explicitly.
    process.env.OPENHERMIT_UPLOAD_SINCE_HOURS = '0';
    await mkdir(path.join(hermitHome, 'auth'), { recursive: true });
    await writeFile(
      path.join(hermitHome, 'auth', 'openhermit.json'),
      JSON.stringify({ token: { accessToken: 'token', expiresAt: '2999-01-01T00:00:00.000Z' } })
    );
    setClaudeBasePathOverride(claudeBase);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    delete process.env.HERMIT_HOME;
    delete process.env.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL;
    delete process.env.CODEX_HOME;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.HERMIT_USAGE_FOREGROUND_SCAN;
    delete process.env.HERMIT_USAGE_FULL_RESCAN;
    delete process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS;
    delete process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE;
    delete process.env.OPENHERMIT_UPLOAD_SINCE_HOURS;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults message upload to disabled when telemetry has no explicit opt-in', async () => {
    const result = await uploadConversationMessages({ telemetry: {} });

    expect(result.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors canonical upload opt-out even when stale legacy state is enabled', async () => {
    const result = await uploadConversationMessages({
      telemetry: {
        conversationUploadEnabled: false,
        conversations: { uploadEnabled: true },
      },
    });

    expect(result.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps healthy providers uploading when another usage channel is not deployed yet', async () => {
    const projectDir = path.join(claudeBase, 'projects', '-tmp-provider-isolation');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-provider-isolation.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-provider-isolation',
        uuid: 'msg-provider-isolation',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'still upload Claude', model: 'claude-test-model' },
      })}\n`
    );

    let messagePosts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        const platform = new URL(url).searchParams.get('client');
        if (platform === 'codex') return Response.json({ detail: 'not deployed' }, { status: 404 });
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        messagePosts += 1;
        return Response.json(
          {
            ok: true,
            uploadId: 'upl-provider-isolation',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode', 'codex'],
      },
    });

    expect(messagePosts).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.lastError).toContain('codex');
  });

  it('bounds the first periodic scan to recent messages when no cursor exists (no full-history backfill)', async () => {
    // Regression for the 776s hang: a channel that has never reported used to
    // scan ALL history on its first cycle. The periodic worker now skips messages
    // older than the since-window; only a manual full rescan re-uploads history.
    process.env.OPENHERMIT_UPLOAD_SINCE_HOURS = '24';
    delete process.env.HERMIT_USAGE_FOREGROUND_SCAN; // periodic daemon, not foreground
    delete process.env.HERMIT_USAGE_FULL_RESCAN;
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    const recentIso = (hoursAgo: number) =>
      new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const oldIso = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(); // 3 days ago → filtered
    const line = (uuid: string, ts: string) =>
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        uuid,
        cwd: '/tmp/project',
        timestamp: ts,
        message: { role: 'user', content: `msg-${uuid}`, model: 'claude-test-model' },
      })}\n`;
    await writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      `${line('old-1', oldIso)}${line('new-1', recentIso(1))}${line('new-2', recentIso(2))}`
    );

    const posted: { eventId?: string }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          feishu_authorized: true,
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        posted.push(...(body.messages ?? []));
        return Response.json({
          ok: true,
          receiptId: 'r1',
          uploadId: 'u1',
          received: posted.length,
          acceptedForProcessing: posted.length,
          status: 'queued',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    // 3 fixtures, but the 3-day-old one is outside the 24h window → only 2 uploaded.
    expect(posted.length).toBe(2);
    // Identify messages by eventId (not content text — Lane A strips the body).
    const eventIds = posted.map((m: { eventId?: string }) => m.eventId);
    expect(eventIds).toContain('claudecode:session-1:new-1');
    expect(eventIds).toContain('claudecode:session-1:new-2');
    expect(eventIds).not.toContain('claudecode:session-1:old-1');
  });

  it('uses message.occurredAt with a half-open upload window', async () => {
    process.env.OPENHERMIT_UPLOAD_SINCE_HOURS = '168';
    delete process.env.HERMIT_USAGE_FOREGROUND_SCAN;
    delete process.env.HERMIT_USAGE_FULL_RESCAN;
    const referenceMs = Date.parse('2026-07-09T12:00:00.000Z');
    const projectDir = path.join(claudeBase, 'projects', '-tmp-window');
    await mkdir(projectDir, { recursive: true });
    const line = (uuid: string, timestamp: string, tokens: number) =>
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session-window',
        uuid,
        cwd: '/tmp/project',
        timestamp,
        message: {
          role: 'assistant',
          content: `msg-${uuid}`,
          model: 'claude-test-model',
          usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
        },
      })}\n`;
    await writeFile(
      path.join(projectDir, 'session-window.jsonl'),
      [
        line('start-in', '2026-07-02T12:00:00.000Z', 10),
        line('end-out', '2026-07-09T12:00:00.000Z', 20),
        line('future-out', '2026-07-09T12:00:00.001Z', 30),
        line('old-out', '2026-07-02T11:59:59.999Z', 40),
      ].join('')
    );

    const posted: { eventId?: string; message?: { usage?: { totalTokens?: number } } }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        posted.push(...(body.messages ?? []));
        return Response.json({
          ok: true,
          receiptId: 'r1',
          uploadId: 'u1',
          received: body.messages?.length ?? 0,
          acceptedForProcessing: body.messages?.length ?? 0,
          status: 'queued',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await uploadConversationMessages(
      {
        telemetry: {
          enabled: true,
          platform: 'claudecode',
          conversationUploadEnabled: true,
          uploadProviders: ['claudecode'],
        },
      },
      referenceMs
    );

    expect(posted.map((message) => message.eventId)).toEqual([
      'claudecode:session-window:start-in',
    ]);
    expect(posted[0]?.message?.usage?.totalTokens).toBe(10);
  });

  it('ships full conversation text in uploads (content transmission enabled)', async () => {
    // Conversation text is now transmitted in full (not content-stripped). The
    // real user/assistant text populates `message.content`; usage + metadata
    // (eventId, model, project hash) are still uploaded so token attribution and
    // eventId dedup are unchanged. Text-less tool-use turns report the tool name.
    process.env.OPENHERMIT_UPLOAD_SINCE_HOURS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-novault');
    await mkdir(projectDir, { recursive: true });
    const secret = 'SUPER_SECRET_PROMPT_TEXT_42';
    await writeFile(
      path.join(projectDir, 'session-novault.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-novault',
        uuid: 'message-novault',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: secret, model: 'claude-test-model' },
      })}\n`
    );

    const posted: { eventId?: string; message?: { content?: string } }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        posted.push(...body.messages);
        return Response.json({
          ok: true,
          uploadId: 'u-novault',
          status: 'queued',
          received: body.messages.length,
          acceptedForProcessing: body.messages.length,
          rejectedAtReceive: 0,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(posted).toHaveLength(1);
    // The real prompt text IS shipped in full, verbatim.
    expect(posted[0].eventId).toBe('claudecode:session-novault:message-novault');
    expect(posted[0].message?.content).toBe(secret);
  });

  it('reports the invoked tool name(s) as content for text-less tool-use turns', async () => {
    // A tool-use turn has no readable text but carries the tool name(s). The
    // analytics side is better served by "Bash, Read" than the generic
    // [usage only] placeholder, so text-less tool-use turns now surface the
    // invoked tool name(s); the placeholder only survives for usage-bearing
    // turns with neither text nor a tool_use block.
    process.env.OPENHERMIT_UPLOAD_SINCE_HOURS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-tooluse');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-tooluse.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session-tooluse',
        uuid: 'message-tooluse',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:21:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-test-model',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.txt' } },
          ],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      })}\n`
    );

    const posted: { eventId?: string; message?: { content?: string } }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        posted.push(...body.messages);
        return Response.json({
          ok: true,
          uploadId: 'u-tooluse',
          status: 'queued',
          received: body.messages.length,
          acceptedForProcessing: body.messages.length,
          rejectedAtReceive: 0,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(posted).toHaveLength(1);
    // Text-less tool-use turn reports the invoked tool name(s), not the placeholder.
    expect(posted[0].message?.content).toBe('Bash, Read');
  });

  it('uses the shared totalTokens calculation when total_tokens is missing', async () => {
    const projectDir = path.join(claudeBase, 'projects', '-tmp-missing-total');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-missing-total.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session-missing-total',
        uuid: 'message-missing-total',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: {
          role: 'assistant',
          content: 'usage with missing total',
          model: 'claude-test-model',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 56,
            cache_creation_input_tokens: 78,
          },
        },
      })}\n`
    );

    const posted: { message?: { usage?: { totalTokens?: number } } }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        posted.push(...body.messages);
        return Response.json({
          ok: true,
          uploadId: 'u-missing-total',
          status: 'queued',
          received: body.messages.length,
          acceptedForProcessing: body.messages.length,
          rejectedAtReceive: 0,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].message?.usage?.totalTokens).toBe(180);
  });

  it('uses server usage status as cursor source and does not send client uploadId', async () => {
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        uuid: 'message-1',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'hello', model: 'claude-test-model' },
      })}\n`
    );

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          feishu_authorized: true,
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: url.includes('client=codex') ? 'codex' : 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty('uploadId');
        expect(body).not.toHaveProperty('upload_id');
        expect(body.clientCursor).toMatchObject({
          schemaVersion: 1,
          purpose: 'local-jsonl-scan-position',
          messageCount: 1,
        });
        expect(body.messages).toHaveLength(1);
        expect(body.schemaVersion).toBe(1);
        expect(body.scene).toBe('coding');
        expect(body).not.toHaveProperty('platform');
        expect(body).toMatchObject({ reporter: 'agentcli', client: { tool: 'claudecode' } });
        // 新协议 ReportClient 仅允许 {tool}（additionalProperties:false）：锁死 wire 上
        // client 只携带 tool，禁止 version/instanceId 等附加字段触发 422。
        expect(Object.keys(body.client)).toEqual(['tool']);
        expect(body.messages[0]).toMatchObject({
          kind: 'conversation_message',
          eventId: 'claudecode:session-1:message-1',
          conversation: { conversationId: 'session-1', sessionRef: 'claudecode:session-1' },
          message: { messageRef: 'message-1', modelName: 'claude-test-model' },
        });
        expect(body.messages[0].message).not.toHaveProperty('model');
        // 模拟线上服务端契约：ReportUploadConversation 为 additionalProperties:false，
        // 仅允许 conversationId / sessionRef / startedAt。出现 claudeSessionRef 等额外字段
        // 时服务端返回 422 extra_forbidden（loc: messages[].conversation.claudeSessionRef），
        // 上报整体失败、lastError 被置位——与 ~/.hermit/logs/conversation-upload.log 一致。
        const allowedConversationKeys = new Set(['conversationId', 'sessionRef', 'startedAt']);
        const forbiddenConversationKeys = body.messages.flatMap(
          (m: { conversation?: Record<string, unknown> }) =>
            Object.keys(m.conversation ?? {}).filter((k) => !allowedConversationKeys.has(k))
        );
        if (forbiddenConversationKeys.length) {
          return Response.json(
            {
              detail: {
                code: 'schema_validation_failed',
                errorCount: forbiddenConversationKeys.length,
                errors: forbiddenConversationKeys.map((key: string) => ({
                  type: 'extra_forbidden',
                  loc: ['body', 'messages', 0, 'conversation', key],
                  msg: 'Extra inputs are not permitted',
                })),
              },
            },
            { status: 422 }
          );
        }
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_server_generated',
            receiptId: 'receipt-1',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
            detailUrl: '/api/v1/report/uploads/upl_server_generated',
          },
          { status: 202 }
        );
      }
      // No per-batch status polling: the /uploads/:id endpoint is never fetched.
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.uploadIds).toEqual(['upl_server_generated']);
    await expect(
      readFile(path.join(hermitHome, 'telemetry', 'conversation-message-scan-cursor.json'), 'utf-8')
    ).rejects.toThrow();
  });

  it('uses server cursor offsets for background incremental scans', async () => {
    delete process.env.HERMIT_USAGE_FOREGROUND_SCAN;
    delete process.env.HERMIT_USAGE_FULL_RESCAN;
    const { createHash } = await import('node:crypto');
    const projectDir = path.join(claudeBase, 'projects', '-tmp-incremental');
    await mkdir(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, 'session-incremental.jsonl');
    const uploadedLine = `${JSON.stringify({
      type: 'user',
      sessionId: 'session-incremental',
      uuid: 'already-uploaded',
      cwd: '/tmp/project',
      timestamp: '2026-06-24T08:20:00.000Z',
      message: { role: 'user', content: 'already uploaded', model: 'claude-test-model' },
    })}\n`;
    const newLine = `${JSON.stringify({
      type: 'user',
      sessionId: 'session-incremental',
      uuid: 'new-message',
      cwd: '/tmp/project',
      timestamp: '2026-06-24T08:21:00.000Z',
      message: { role: 'user', content: 'new only', model: 'claude-test-model' },
    })}\n`;
    await writeFile(sessionPath, `${uploadedLine}${newLine}`);
    const uploadedOffset = Buffer.byteLength(uploadedLine, 'utf-8');
    const fileKey = createHash('sha256').update(sessionPath).digest('hex');
    const postedEventIds: string[] = [];

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'success',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: {
                schemaVersion: 1,
                purpose: 'local-jsonl-scan-position',
                generatedAt: '2026-06-24T08:20:30.000Z',
                files: [
                  {
                    fileKey,
                    pathHash: `sha256-${fileKey}`,
                    size: uploadedOffset,
                    mtimeMs: 1,
                    fromOffset: 0,
                    toOffset: uploadedOffset,
                  },
                ],
                fileCount: 1,
                messageCount: 1,
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        postedEventIds.push(
          ...body.messages.map((message: { eventId: string }) => message.eventId)
        );
        expect(body.clientCursor.files[0]).toMatchObject({
          fileKey,
          fromOffset: uploadedOffset,
          toOffset: uploadedOffset + Buffer.byteLength(newLine, 'utf-8'),
        });
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_incremental',
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(result.attempted).toBe(1);
    expect(postedEventIds).toEqual(['claudecode:session-incremental:new-message']);
  });

  it('full rescan scans all history while still uploading in batches', async () => {
    process.env.HERMIT_USAGE_FULL_RESCAN = '1';
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-full-rescan');
    await mkdir(projectDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'session-full-rescan',
        uuid: `message-${index + 1}`,
        cwd: '/tmp/project',
        timestamp: `2026-06-24T08:2${index}:00.000Z`,
        message: {
          role: 'user',
          content: `full rescan ${index + 1}`,
          model: 'claude-test-model',
          usage: { totalTokens: 10 },
        },
      })
    );
    await writeFile(path.join(projectDir, 'session-full-rescan.jsonl'), `${lines.join('\n')}\n`);

    const batchSizes: number[] = [];
    const eventIds: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'success',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: {
                schemaVersion: 1,
                purpose: 'local-jsonl-scan-position',
                generatedAt: '2026-06-24T08:30:00.000Z',
                files: [
                  {
                    fileKey: 'already-at-end',
                    pathHash: 'old',
                    fromOffset: 0,
                    toOffset: 999999,
                    size: 999999,
                    mtimeMs: 1,
                  },
                ],
                fileCount: 1,
                messageCount: 999,
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        batchSizes.push(body.messages.length);
        eventIds.push(...body.messages.map((message: { eventId: string }) => message.eventId));
        return Response.json(
          {
            ok: true,
            uploadId: `upl_full_${batchSizes.length}`,
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { batchSize: 2, uploadBatchSize: 2 },
      },
    });

    expect(batchSizes).toEqual([2, 2, 1]);
    expect(eventIds).toHaveLength(5);
    expect(result.attempted).toBe(5);
    expect(result.pending).toBe(0);
    expect(result.pendingTokens).toBe(0);
  });
  it('full rescan across multiple windows keeps uploaded <= discovered (no 617/117)', async () => {
    process.env.HERMIT_USAGE_FULL_RESCAN = '1';
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-multi-window');
    await mkdir(projectDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'session-multi-window',
        uuid: `message-${index + 1}`,
        cwd: '/tmp/project',
        timestamp: `2026-06-24T08:2${index}:00.000Z`,
        message: {
          role: 'user',
          content: `multi window ${index + 1}`,
          model: 'claude-test-model',
          usage: { totalTokens: 10 },
        },
      })
    );
    await writeFile(path.join(projectDir, 'session-multi-window.jsonl'), `${lines.join('\n')}\n`);

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        return Response.json(
          {
            ok: true,
            uploadId: `upl_mw_${body.messages[0]?.messageRef}`,
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        // windowSize=2 forces 3 windows for 5 messages; uploadedAfterBatch is
        // cumulative while totalMessages must track cumulative discovered too.
        conversations: { batchSize: 2, uploadBatchSize: 2, fullRescanWindowSize: 2 },
      },
    });

    // Regression guard for the 消息 617/117 bug: cumulative uploaded must never
    // exceed cumulative discovered, and pending must never go negative.
    expect(result.attempted).toBe(5);
    expect(result.totalDiscovered).toBeGreaterThanOrEqual(result.accepted);
    expect(result.pending).toBeGreaterThanOrEqual(0);
  });

  it('sends an Idempotency-Key header equal to the sha256 of the exact request body', async () => {
    const { createHash } = await import('node:crypto');
    const projectDir = path.join(claudeBase, 'projects', '-tmp-idem');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-idem.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-idem',
        uuid: 'message-idem',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'idempotency check', model: 'claude-test-model' },
      })}\n`
    );

    const posted: { headers: Record<string, string>; body: string }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          feishu_authorized: true,
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        posted.push({
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body),
        });
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_idem',
            receiptId: 'r-1',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(posted).toHaveLength(1);
    const key = posted[0].headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key).toHaveLength(64); // sha256 hex
    // The key is the body's own fingerprint: identical body ⟺ identical key, so the
    // doc's same-key+different-body 409 can never fire from this client.
    expect(key).toBe(createHash('sha256').update(posted[0].body).digest('hex'));
  });

  it('skips uploading when server reports in-flight batches for the channel', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: url.includes('client=codex') ? 'codex' : 'claudecode',
              scene: 'coding',
              status: 'processing',
              inFlight: { count: 1, uploadIds: ['upl_inflight'] },
              currentCursor: null,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(result.attempted).toBe(0);
    expect(result.uploadIds).toEqual(['upl_inflight']);
    expect(result.lastError).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/report/messages'),
      expect.anything()
    );
  });

  it('drains past in-flight on a foreground scan (--scan-once) instead of skipping', async () => {
    // Regression: 扫描一次 / `usage report` run as --scan-once children with
    // HERMIT_USAGE_FOREGROUND_SCAN=1. A pending backlog must actually upload,
    // not skip forever while the server finishes a prior batch.
    process.env.HERMIT_USAGE_FOREGROUND_SCAN = '1';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-1.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        uuid: 'message-1',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'hello' },
      })}\n`
    );

    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: url.includes('client=codex') ? 'codex' : 'claudecode',
              scene: 'coding',
              status: 'processing',
              inFlight: { count: 1, uploadIds: ['upl_inflight'] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_new',
            receiptId: 'receipt-1',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    // It pushed through the in-flight state and uploaded — the backlog drains.
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/report/messages'),
      expect.anything()
    );
  });

  it('proceeds to upload (relying on server eventId dedup) when a prior upload has no committed cursor', async () => {
    // The client never skips on a missing cursor: a prior upload without a
    // committed cursor just means the server-side cursor commit hasn't landed yet
    // (or this is the channel's first upload). The client re-scans and re-posts;
    // the server dedupes by eventId, so already-uploaded messages come back as
    // duplicates (not double-counted). Skipping here would stall the channel
    // forever while a backlog sits — the documented behavior at the upload site.
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-no-cursor.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-no-cursor',
        uuid: 'message-no-cursor',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'hello' },
      })}\n`
    );

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'success',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
              lastUploadId: 'upl_prior_without_cursor',
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        // Server-side dedup: a re-sent eventId comes back as a duplicate, not a
        // double-count. The client still POSTs it (attempted), relying on the server.
        const received = body.messages.length;
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_dedup',
            status: 'queued',
            received,
            acceptedForProcessing: 0,
            duplicatedAtReceive: received,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    // It PROCEEDED (did not skip) and POSTed to the unified endpoint; the server
    // accepted the dedup without an intake error.
    expect(result.attempted).toBe(1);
    expect(result.lastError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/report/messages'),
      expect.anything()
    );
  });

  it('refreshes an expired token before uploading (worker path no longer bails to 等待登录)', async () => {
    // Overwrite the far-future token from beforeEach with an EXPIRED one + a
    // refresh token. getValidBearerToken must proactively refresh, or the worker
    // reads an expired token and skips the upload entirely — the regression this
    // test guards.
    await writeFile(
      path.join(hermitHome, 'auth', 'openhermit.json'),
      JSON.stringify({
        token: {
          accessToken: 'expired',
          expiresAt: '2000-01-01T00:00:00.000Z',
          refreshToken: 'rt',
        },
      })
    );
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-refresh.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'session-refresh',
        uuid: 'msg-refresh',
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: 'hello' },
      })}\n`
    );

    let refreshed = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshed = true;
        return Response.json({
          access_token: 'fresh',
          access_expires_in: 3600,
          scope: 'upload:read upload:write',
        });
      }
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_refresh',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
            detailUrl: '/api/v1/report/uploads/upl_refresh',
          },
          { status: 202 }
        );
      }
      // No per-batch status polling: the /uploads/:id endpoint is never fetched.
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(refreshed).toBe(true);
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);
    expect(result.uploadIds).toEqual(['upl_refresh']);
    expect(result.lastError).toBeUndefined();
  });

  it('sends all batches off the receipt without per-batch status polling — no UI freeze', async () => {
    // Regression guard for the "首次上报卡死" bug: the removed per-batch
    // terminal-status poll (up to 10 x 1.5s = ~15s/batch) made a 199-batch first
    // backfill take an hour and froze the interactive menu. Upload must POST every
    // batch off the receipt alone and NEVER hit the /uploads/:id status endpoint —
    // /report/usage/status is the server-authoritative fact source for committed cursor
    // and aggregate counts.
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE = '2'; // 3 messages => 2 batches
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-project');
    await mkdir(projectDir, { recursive: true });
    const lines = [1, 2, 3].map((i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'session-fast',
        uuid: `m${i}`,
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: `hello ${i}` },
      })
    );
    await writeFile(path.join(projectDir, 'session-fast.jsonl'), `${lines.join('\n')}\n`);

    let uploadPosts = 0;
    let statusPolls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        uploadPosts += 1;
        const count = JSON.parse(String(init?.body)).messages.length;
        // Receipt is non-terminal ('queued') — on the confirm path this would
        // trigger polling; the fast path must NOT poll.
        return Response.json(
          {
            ok: true,
            uploadId: `upl_fast_${uploadPosts}`,
            status: 'queued',
            received: count,
            acceptedForProcessing: count,
            rejectedAtReceive: 0,
            detailUrl: `/api/v1/report/uploads/upl_fast_${uploadPosts}`,
          },
          { status: 202 }
        );
      }
      if (url.includes('/api/v1/report/uploads/')) {
        statusPolls += 1;
        return Response.json({ ok: true, status: 'success', accepted: 2, cursorCommitted: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
      },
    });

    expect(uploadPosts).toBe(2); // both batches sent
    expect(statusPolls).toBe(0); // NO per-batch polling — this is the freeze fix
    expect(result.attempted).toBe(3);
    expect(result.lastError).toBeUndefined(); // non-terminal receipt must NOT abort the run
    expect(result.pending).toBe(0); // batches count as sent; no misleading "N 待上报"
    expect(result.pendingTokens).toBe(0); // token backlog drains to 0 on a fully-successful upload too
    delete process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE;
  });

  it('uploads Pi messages with usage and deduplicates entries copied into cloned sessions', async () => {
    const piSessionsRoot = path.join(tmpDir, '.pi', 'agent', 'sessions');
    process.env.PI_CODING_AGENT_SESSION_DIR = piSessionsRoot;
    const projectDir = path.join(piSessionsRoot, '--tmp-pi-project--');
    await mkdir(projectDir, { recursive: true });
    const originalPath = path.join(
      projectDir,
      '2026-07-20T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl'
    );
    const copiedEntries = [
      {
        type: 'message',
        id: 'user0001',
        parentId: null,
        timestamp: '2026-07-20T00:00:01.000Z',
        message: { role: 'user', content: 'Run the checks', timestamp: 1_784_505_601_000 },
      },
      {
        type: 'message',
        id: 'assist01',
        parentId: 'user0001',
        timestamp: '2026-07-20T00:00:02.000Z',
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-test',
          timestamp: 1_784_505_602_000,
          content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
          usage: {
            input: 10,
            output: 2,
            cacheRead: 3,
            cacheWrite: 1,
            totalTokens: 16,
          },
        },
      },
    ];
    await writeFile(
      originalPath,
      [
        {
          type: 'session',
          version: 3,
          id: '00000000-0000-0000-0000-000000000001',
          timestamp: '2026-07-20T00:00:00.000Z',
          cwd: '/tmp/pi-project',
        },
        ...copiedEntries,
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );
    await writeFile(
      path.join(projectDir, '2026-07-20T01-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl'),
      [
        {
          type: 'session',
          version: 3,
          id: '00000000-0000-0000-0000-000000000002',
          timestamp: '2026-07-20T01:00:00.000Z',
          cwd: '/tmp/pi-project',
          parentSession: originalPath,
        },
        ...copiedEntries,
        {
          type: 'message',
          id: 'assist02',
          parentId: 'assist01',
          timestamp: '2026-07-20T01:00:02.000Z',
          message: {
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-test',
            timestamp: 1_784_509_202_000,
            content: [{ type: 'text', text: 'Checks passed' }],
            usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 8 },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );

    const posted: {
      eventId?: unknown;
      conversation?: Record<string, unknown>;
      message?: Record<string, unknown>;
    }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        expect(url).toContain('client=pi');
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'pi',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ reporter: 'agentcli', client: { tool: 'pi' } });
        posted.push(...body.messages);
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_pi',
            receiptId: 'r-pi',
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'pi',
        conversationUploadEnabled: true,
        uploadProviders: ['pi'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(result.attempted).toBe(3);
    expect(posted).toHaveLength(3);
    expect(new Set(posted.map((message) => message.eventId))).toHaveLength(3);
    expect(posted.every((message) => /^pi:[a-f0-9]{64}$/u.test(String(message.eventId)))).toBe(
      true
    );
    expect(posted.find((message) => message.message?.messageRef === 'assist01')).toMatchObject({
      conversation: { conversationId: '00000000-0000-0000-0000-000000000001' },
      message: {
        parentRef: 'user0001',
        modelName: 'gpt-test',
        content: 'bash',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 1,
          totalTokens: 16,
        },
      },
    });
  });

  it('uploads Codex token_count records from new payload.info usage shape', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '02');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'rollout-session-1.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-02T00:16:00.000Z',
        type: 'session_meta',
        payload: {
          type: 'session_meta',
          session_id: 'rollout-session-1',
          cwd: '/tmp/codex-project',
          model_provider: 'glm',
        },
      })}\n${JSON.stringify({
        timestamp: '2026-07-02T00:16:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: 'turn-1',
          cwd: '/tmp/codex-project',
          model: 'glm-5.2',
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 5,
              output_tokens: 7,
              reasoning_output_tokens: 3,
              total_tokens: 35,
            },
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 2,
              output_tokens: 4,
              reasoning_output_tokens: 1,
              total_tokens: 18,
            },
          },
        },
      })}\n`
    );

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        expect(url).toContain('client=codex');
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'codex',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          reporter: 'agentcli',
          client: { tool: 'codex' },
          scene: 'coding',
        });
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0]).toMatchObject({
          eventId: 'codex:rollout-session-1:turn-1',
          project: { name: 'codex-project' },
          conversation: {
            conversationId: 'rollout-session-1',
            sessionRef: 'codex:rollout-session-1',
          },
          message: {
            messageRef: 'turn-1',
            modelName: 'glm-5.2',
            usage: {
              inputTokens: 11,
              cacheReadTokens: 2,
              outputTokens: 5,
              cacheCreationTokens: 0,
              totalTokens: 18,
            },
          },
        });
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_codex',
            receiptId: 'r-codex',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'codex',
        conversationUploadEnabled: true,
        uploadProviders: ['codex'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(result.attempted).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it('restores the exact Codex model from before the incremental cursor and ignores model_provider', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'rollout-incremental-model.jsonl');
    const prefix = `${JSON.stringify({
      timestamp: '2026-07-30T18:00:00.000Z',
      type: 'turn_context',
      // Real Codex JSONL keeps `turn_context` on the top-level record and does
      // not include payload.type. Incremental recovery must still retain model.
      payload: {
        cwd: '/tmp/codex-incremental',
        model: 'gpt-5.6-sol',
      },
    })}\n`;
    const incremental = `${JSON.stringify({
      timestamp: '2026-07-30T18:01:00.000Z',
      type: 'session_meta',
      payload: { type: 'session_meta', model_provider: 'openai' },
    })}\n${JSON.stringify({
      timestamp: '2026-07-30T18:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        turn_id: 'turn-incremental',
        // A provider label must not overwrite the exact recovered model.
        model: 'openai',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    })}\n`;
    await writeFile(sessionPath, `${prefix}${incremental}`);
    const uploadedOffset = Buffer.byteLength(prefix, 'utf8');
    const key = createHash('sha256').update(sessionPath).digest('hex');

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'codex',
              scene: 'coding',
              status: 'success',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: {
                schemaVersion: 1,
                purpose: 'local-jsonl-scan-position',
                generatedAt: '2026-07-30T18:00:30.000Z',
                files: [
                  {
                    fileKey: key,
                    pathHash: `sha256-${key}`,
                    size: uploadedOffset,
                    mtimeMs: 1,
                    fromOffset: 0,
                    toOffset: uploadedOffset,
                  },
                ],
                fileCount: 1,
                messageCount: 1,
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].message).toMatchObject({
          modelName: 'gpt-5.6-sol',
          usage: { totalTokens: 14 },
        });
        expect(body.messages[0].message.modelName).not.toBe('openai');
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_incremental_codex',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'codex',
        conversationUploadEnabled: true,
        uploadProviders: ['codex'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(result.attempted).toBe(1);
  });

  it('allows model-less Codex text and info:null rows while holding unpriced usage at its cursor', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '03');
    await mkdir(sessionDir, { recursive: true });

    const textPath = path.join(sessionDir, 'a-model-less-text.jsonl');
    const usagePath = path.join(sessionDir, 'b-model-less-usage.jsonl');
    await writeFile(
      textPath,
      `${JSON.stringify({
        timestamp: '2026-08-03T09:39:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null },
      })}\n${JSON.stringify({
        timestamp: '2026-08-03T09:40:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          id: 'text-without-model',
          message: 'Plain text does not require pricing metadata.',
        },
      })}\n`
    );
    const usagePrefix = `${JSON.stringify({
      timestamp: '2026-08-03T09:40:30.000Z',
      type: 'session_meta',
      payload: { cwd: '/tmp/model-less-usage' },
    })}\n`;
    await writeFile(
      usagePath,
      `${usagePrefix}${JSON.stringify({
        timestamp: '2026-08-03T09:41:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: 'usage-without-model',
          info: {
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
        },
      })}\n`
    );

    const textFileKey = createHash('sha256').update(textPath).digest('hex');
    const usageFileKey = createHash('sha256').update(usagePath).digest('hex');
    const usageUploadedOffset = Buffer.byteLength(usagePrefix, 'utf8');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'codex',
              scene: 'coding',
              status: 'succeeded',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: {
                schemaVersion: 1,
                purpose: 'local-jsonl-scan-position',
                generatedAt: '2026-08-03T09:40:45.000Z',
                files: [
                  {
                    fileKey: usageFileKey,
                    pathHash: `sha256-${usageFileKey}`,
                    size: usageUploadedOffset,
                    mtimeMs: 1,
                    fromOffset: 0,
                    toOffset: usageUploadedOffset,
                  },
                ],
                fileCount: 1,
                messageCount: 0,
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0]).toMatchObject({
          eventId: 'codex:a-model-less-text:text-without-model',
        });
        expect(body.messages[0].message.modelName).toBeUndefined();
        expect(body.messages[0].message.usage).toBeUndefined();
        const cursorFiles = new Map(
          body.clientCursor.files.map(
            (file: { fileKey: string; fromOffset: number; toOffset: number }) => [
              file.fileKey,
              file,
            ]
          )
        );
        expect(cursorFiles.get(textFileKey)).toBeDefined();
        expect(cursorFiles.get(usageFileKey)).toMatchObject({
          fromOffset: usageUploadedOffset,
          toOffset: usageUploadedOffset,
        });
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_model_less_text',
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'codex',
        conversationUploadEnabled: true,
        uploadProviders: ['codex'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(result.attempted).toBe(1);
    const uploadLog = await readFile(
      path.join(hermitHome, 'logs', 'conversation-upload.log'),
      'utf8'
    );
    expect(uploadLog).toContain('codex file quarantined: exact model unavailable');
  });

  it('uploads per-turn deltas, not cumulative snapshots, for total_token_usage-only Codex logs', async () => {
    // Real Codex logs may omit last_token_usage and carry only the CUMULATIVE
    // total_token_usage. The server sums message.usage.totalTokens, so sending
    // raw cumulative snapshots (100,200,300) would total 600 — double the real
    // 300. The client must convert each snapshot to a per-turn delta.
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '02');
    await mkdir(sessionDir, { recursive: true });
    const tokenLine = (cumulative: number, ts: string) =>
      `${JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: cumulative,
              output_tokens: 0,
              total_tokens: cumulative,
            },
          },
        },
      })}\n`;
    await writeFile(
      path.join(sessionDir, 'rollout-cumulative.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-01T23:59:00.000Z',
        type: 'turn_context',
        payload: { type: 'turn_context', model: 'gpt-5.6-sol' },
      })}\n` +
        tokenLine(100, '2026-07-02T00:00:00.000Z') +
        tokenLine(200, '2026-07-02T00:01:00.000Z') +
        tokenLine(300, '2026-07-02T00:02:00.000Z')
    );

    const posted: { eventId: string; totalTokens: number }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'codex',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        for (const m of body.messages) {
          posted.push({ eventId: m.eventId, totalTokens: m.message.usage.totalTokens });
        }
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_cum',
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'codex',
        conversationUploadEnabled: true,
        uploadProviders: ['codex'],
      },
    });

    expect(result.lastError).toBeUndefined();
    expect(posted).toHaveLength(3);
    expect(posted.map((m) => m.totalTokens)).toEqual([100, 100, 100]);
    expect(posted.reduce((sum, m) => sum + m.totalTokens, 0)).toBe(300); // not 600
  });

  it('uploads Codex user_message / agent_message text in full (content transmission)', async () => {
    // Real Codex logs interleave content rows (user_message / agent_message)
    // with token_count rows. Content rows must ship their payload.message text
    // verbatim as real user/assistant messages; response_item/* rows duplicate
    // that text and are skipped.
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '02');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'rollout-content.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-02T00:16:00.000Z',
        type: 'session_meta',
        payload: { type: 'session_meta', session_id: 'rollout-content', cwd: '/tmp/codex-content' },
      })}\n${JSON.stringify({
        timestamp: '2026-07-02T00:16:05.000Z',
        type: 'turn_context',
        payload: { type: 'turn_context', model: 'gpt-5.6-sol' },
      })}\n${JSON.stringify({
        timestamp: '2026-07-02T00:16:10.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Fix the login bug' },
      })}\n${JSON.stringify({
        timestamp: '2026-07-02T00:16:20.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'I will patch the auth check' },
      })}\n${JSON.stringify({
        timestamp: '2026-07-02T00:16:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: 'turn-1',
          cwd: '/tmp/codex-content',
          model: 'glm-5.2',
          info: {
            last_token_usage: { input_tokens: 11, output_tokens: 4, total_tokens: 18 },
          },
        },
      })}\n`
    );

    const posted: { eventId: string; role: string; content: string; totalTokens?: number }[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'codex',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const body = JSON.parse(String(init?.body));
        for (const m of body.messages) {
          posted.push({
            eventId: m.eventId,
            role: m.message.role,
            content: m.message.content,
            totalTokens: m.message.usage?.totalTokens,
          });
        }
        return Response.json(
          {
            ok: true,
            uploadId: 'upl_content',
            status: 'queued',
            received: body.messages.length,
            acceptedForProcessing: body.messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'codex',
        conversationUploadEnabled: true,
        uploadProviders: ['codex'],
      },
    });

    expect(result.lastError).toBeUndefined();
    // user_message + agent_message + token_count = 3 messages, all with real content.
    expect(posted).toHaveLength(3);
    const userMsg = posted.find((m) => m.role === 'user');
    const assistantMsgs = posted.filter((m) => m.role === 'assistant');
    expect(userMsg?.content).toBe('Fix the login bug');
    // agent_message text + the token_count usage event (assistant role).
    expect(assistantMsgs.map((m) => m.content)).toEqual(
      expect.arrayContaining(['I will patch the auth check', 'Codex token usage event'])
    );
    // Usage is only on the token_count event.
    expect(posted.find((m) => m.totalTokens === 18)).toBeDefined();
  });

  it('withUploadLock releases the lock when the locked function throws', async () => {
    const lockPath = path.join(hermitHome, 'telemetry', 'conversation-message-upload.lock');
    await expect(
      withUploadLock(hermitHome, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('withUploadLock releases the lock on success and returns the result', async () => {
    const lockPath = path.join(hermitHome, 'telemetry', 'conversation-message-upload.lock');
    const result = await withUploadLock(hermitHome, async () => 42);
    expect(result).toBe(42);
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('withUploadLock returns null when the lock is held by a live process', async () => {
    // Skip the wait-retry so the test is fast (the default waits up to 60s).
    process.env.HERMIT_UPLOAD_LOCK_WAIT_MS = '0';
    const lockPath = path.join(hermitHome, 'telemetry', 'conversation-message-upload.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
    );
    const result = await withUploadLock(hermitHome, async () => 'should-not-run');
    expect(result).toBeNull();
    delete process.env.HERMIT_UPLOAD_LOCK_WAIT_MS;
  });

  it('aborts the whole run after 2 consecutive transport failures (server down)', async () => {
    // fullRescan window = uploadBatchSize*2 = 2 messages → 2 batches in window 1.
    // Both batches hit a transport failure (safeFetch → HTTP 599). The second
    // consecutive network failure must abort the ENTIRE run — not pay
    // UPLOAD_TIMEOUT_MS × remaining batches — so the 3rd message is never sent.
    process.env.HERMIT_USAGE_FULL_RESCAN = '1';
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE = '1';
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-netfail');
    await mkdir(projectDir, { recursive: true });
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 's-netfail',
        uuid: `m-${i + 1}`,
        cwd: '/tmp/project',
        timestamp: `2026-06-24T08:20:0${i}.000Z`,
        message: { role: 'user', content: `net ${i + 1}`, model: 'claude-test-model' },
      })
    );
    await writeFile(path.join(projectDir, 'session-netfail.jsonl'), `${lines.join('\n')}\n`);

    let messagesCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        messagesCalls += 1;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET', message: 'socket hang up' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { uploadBatchSize: 1 },
      },
    });

    expect(messagesCalls).toBe(2);
    expect(result.lastError ?? '').toMatch(/服务端不可用/);
  });

  it('does NOT abort on business errors (422) — stays on the 3-strike path', async () => {
    // A 422 is a per-batch schema rejection, not a down server. It must NOT
    // trigger the network-failure abort; it falls through to the existing
    // MAX_CONSECUTIVE_FAILURES path. lastError carries the 422, never "服务端不可用".
    process.env.HERMIT_USAGE_FULL_RESCAN = '1';
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE = '1';
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-bizfail');
    await mkdir(projectDir, { recursive: true });
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 's-bizfail',
        uuid: `b-${i + 1}`,
        cwd: '/tmp/project',
        timestamp: `2026-06-24T08:21:0${i}.000Z`,
        message: { role: 'user', content: `biz ${i + 1}`, model: 'claude-test-model' },
      })
    );
    await writeFile(path.join(projectDir, 'session-bizfail.jsonl'), `${lines.join('\n')}\n`);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        return Response.json(
          { detail: { code: 'schema_validation_failed', msg: 'bad' } },
          { status: 422 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { uploadBatchSize: 1 },
      },
    });

    expect(result.lastError ?? '').toMatch(/422/);
    expect(result.lastError ?? '').not.toMatch(/服务端不可用/);
  });

  it('does not attach a full cursor to later successful batches after a 422 rejection', async () => {
    process.env.OPENHERMIT_CONVERSATION_UPLOAD_BATCH_SIZE = '1';
    process.env.OPENHERMIT_UPLOAD_BATCH_DELAY_MS = '0';
    const projectDir = path.join(claudeBase, 'projects', '-tmp-partial-bizfail');
    await mkdir(projectDir, { recursive: true });
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 's-partial-bizfail',
        uuid: `partial-${i + 1}`,
        cwd: '/tmp/project',
        timestamp: `2026-06-24T08:22:0${i}.000Z`,
        message: { role: 'user', content: `partial ${i + 1}`, model: 'claude-test-model' },
      })
    );
    await writeFile(
      path.join(projectDir, 'session-partial-bizfail.jsonl'),
      `${lines.join('\n')}\n`
    );

    let messagePost = 0;
    const batchHasCursor: boolean[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        messagePost += 1;
        const payload = JSON.parse(String(init?.body ?? '{}')) as { clientCursor?: unknown };
        batchHasCursor.push(Boolean(payload.clientCursor));
        if (messagePost === 1) {
          return Response.json(
            { detail: { code: 'pricing_contract_invalid', msg: 'missing_exact_model' } },
            { status: 422 }
          );
        }
        return Response.json(
          {
            ok: true,
            uploadId: `upl_partial_${messagePost}`,
            status: 'queued',
            received: 1,
            acceptedForProcessing: 1,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { uploadBatchSize: 1 },
      },
    });

    expect(messagePost).toBe(3);
    expect(batchHasCursor).toEqual([false, false, false]);
    expect(result.lastError ?? '').toMatch(/422/);
    expect(result.pending).toBe(1);
  });

  it('proactively refreshes the access token before each upload batch when within the expiry buffer', async () => {
    // Regression for "抱着抱着报权限错": a long multi-batch run outlasts the
    // access-token TTL. The token is captured once at the start, so without a
    // per-batch refresh the next POST ships an expired token → a permission
    // error mid-run. With the fix, getValidBearerToken runs before EVERY batch
    // and refreshes whenever the token is within EXPIRY_BUFFER_MS (90s).
    await writeFile(
      path.join(hermitHome, 'auth', 'openhermit.json'),
      JSON.stringify({
        token: {
          accessToken: 'near-expiry',
          refreshToken: 'rt',
          // 60s out ⇒ inside the 90s proactive-refresh buffer, same shape as a
          // token that will die mid-run if not refreshed.
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    );
    // 3 messages, uploadBatchSize 2 ⇒ 2 batches.
    const projectDir = path.join(claudeBase, 'projects', '-tmp-refresh');
    await mkdir(projectDir, { recursive: true });
    const lines = [0, 1, 2].map((i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'session-refresh',
        uuid: `msg-${i}`,
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: `m${i}`, model: 'claude-test-model' },
      })
    );
    await writeFile(path.join(projectDir, 'session-refresh.jsonl'), `${lines.join('\n')}\n`);

    let refreshCalls = 0;
    let messagesCalls = 0;
    const messageBatchSizes: number[] = [];
    const batchHasCursor: boolean[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCalls += 1;
        return Response.json({
          access_token: `refreshed-${refreshCalls}`,
          token_type: 'Bearer',
          // Still within the 90s buffer ⇒ the next batch's getValidBearerToken
          // refreshes again, isolating the per-batch wiring from start-of-run.
          access_expires_in: 60,
          scope: 'upload:read upload:write report:read',
        });
      }
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as {
          clientCursor?: unknown;
          messages?: { conversation?: { conversationId?: string } }[];
        };
        const messages = payload.messages ?? [];
        const belongsToRefreshSession = messages.every(
          (message) => message.conversation?.conversationId === 'session-refresh'
        );
        if (belongsToRefreshSession) {
          messagesCalls += 1;
          messageBatchSizes.push(messages.length);
          batchHasCursor.push(Boolean(payload.clientCursor));
        }
        return Response.json(
          {
            ok: true,
            uploadId: `upl_${messagesCalls}`,
            status: 'queued',
            received: messages.length,
            acceptedForProcessing: messages.length,
            rejectedAtReceive: 0,
          },
          { status: 202 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { uploadBatchSize: 2 },
      },
    });

    // Both batches shipped...
    expect(messageBatchSizes).toEqual([2, 1]);
    expect(batchHasCursor).toEqual([false, true]);
    expect(messagesCalls).toBe(2);
    // ...and refresh fired once per batch PLUS the start-of-run getValidBearerToken
    // (≥ 3). Without the per-batch refresh, refreshCalls would be 1 (start only) and
    // a token expiring mid-run would surface as a permission error.
    expect(refreshCalls).toBeGreaterThanOrEqual(3);
    expect(result.lastError).toBeUndefined();
  });

  it('logs the transport-error cause (ECONNRESET) on failed batches, not a bare HTTP 599', async () => {
    // Regression for "只给个599，鬼知道哪里报错": safeFetch turns a transport
    // failure into a synthetic 599 with the cause in statusText. The diagnostic
    // + upload-response log must carry that statusText (fetch failed (ECONNRESET))
    // so the cause reaches lastError AND the persistent log — not a meaningless
    // "HTTP 599" that tells nobody what broke.
    const projectDir = path.join(claudeBase, 'projects', '-tmp-cause');
    await mkdir(projectDir, { recursive: true });
    const lines = [0, 1].map((i) =>
      JSON.stringify({
        type: 'user',
        sessionId: 'session-cause',
        uuid: `msg-${i}`,
        cwd: '/tmp/project',
        timestamp: '2026-06-24T08:20:00.000Z',
        message: { role: 'user', content: `m${i}`, model: 'claude-test-model' },
      })
    );
    await writeFile(path.join(projectDir, 'session-cause.jsonl'), `${lines.join('\n')}\n`);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/me')) {
        return Response.json({
          authenticated: true,
          status: 'ok',
          scopes: ['upload:read', 'upload:write'],
        });
      }
      if (url.includes('/api/v1/report/usage/status')) {
        return Response.json({
          channels: [
            {
              reporter: 'agentcli',
              client: 'claudecode',
              scene: 'coding',
              status: 'never_reported',
              inFlight: { count: 0, uploadIds: [] },
              currentCursor: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/v1/report/messages')) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNRESET', message: 'socket hang up' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await uploadConversationMessages({
      telemetry: {
        enabled: true,
        platform: 'claudecode',
        conversationUploadEnabled: true,
        uploadProviders: ['claudecode'],
        conversations: { uploadBatchSize: 1 },
      },
    });

    // The cause propagates to lastError via the diagnostic (now including
    // statusText), not a bare "HTTP 599".
    expect(result.lastError ?? '').toMatch(/ECONNRESET/);

    // The persistent upload log captures the cause per failed batch too.
    const logPath = path.join(hermitHome, 'logs', 'conversation-upload.log');
    const logText = await readFile(logPath, 'utf-8');
    const responseEntries = logText
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { message?: string; status?: number; statusText?: string };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { message: string; status: number; statusText: string } =>
        Boolean(entry?.message === 'upload-response')
      );
    expect(responseEntries.length).toBeGreaterThan(0);
    for (const entry of responseEntries) {
      expect(entry.status).toBe(599);
      expect(entry.statusText).toMatch(/ECONNRESET/);
    }
  });
});

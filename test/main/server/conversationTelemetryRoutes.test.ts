import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerConversationTelemetryRoutes } from '../../../src/main/routes/conversationTelemetryRoutes';
import type { ConversationTelemetryService } from '../../../src/main/services/session-intelligence/ConversationTelemetryService';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness(overrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const conversationTelemetry = {
    getConversations: vi.fn(async () => ({ items: [], total: 0 })),
    exportConversations: vi.fn(async (format: string) => ({ format, content: 'exported' })),
    getConversationDetail: vi.fn(async () => ({ sessionId: 'session-1' })),
    ...overrides,
  };
  registerConversationTelemetryRoutes(app, {
    conversationTelemetry: conversationTelemetry as unknown as ConversationTelemetryService,
  });
  return { app, conversationTelemetry };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('conversation telemetry routes', () => {
  it('maps list query filters, content policy, booleans, and pagination', async () => {
    const harness = createHarness();

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations?teamName=team-a&platform=feishu&from=2026-01-01&to=2026-01-02&identityType=person&identityId=user-1&includeContent=full&includeToolResults=false&includeSystemMessages=false&limit=25&offset=5',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], total: 0 });
    expect(harness.conversationTelemetry.getConversations).toHaveBeenCalledWith({
      teamName: 'team-a',
      platform: 'feishu',
      from: '2026-01-01',
      to: '2026-01-02',
      identityType: 'person',
      identityId: 'user-1',
      includeContent: 'full',
      includeToolResults: false,
      includeSystemMessages: false,
      limit: 25,
      offset: 5,
    });
  });

  it('preserves export format allowlisting and defaults unknown formats to CSV', async () => {
    const harness = createHarness();

    await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations/export?format=markdown&includeContent=summary',
    });
    await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations/export?format=xml',
    });

    expect(harness.conversationTelemetry.exportConversations).toHaveBeenNthCalledWith(
      1,
      'markdown',
      expect.objectContaining({
        includeContent: 'summary',
        includeToolResults: true,
        includeSystemMessages: true,
      })
    );
    expect(harness.conversationTelemetry.exportConversations).toHaveBeenNthCalledWith(
      2,
      'csv',
      expect.objectContaining({ includeContent: 'none' })
    );
  });

  it('registers export before the dynamic detail route and forces full detail content', async () => {
    const harness = createHarness();

    const exported = await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations/export',
    });
    const detail = await harness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations/session-1?teamName=team-a&platform=feishu',
    });

    expect(exported.json()).toEqual({ format: 'csv', content: 'exported' });
    expect(detail.json()).toEqual({ sessionId: 'session-1' });
    expect(harness.conversationTelemetry.getConversationDetail).toHaveBeenCalledWith('session-1', {
      teamName: 'team-a',
      platform: 'feishu',
      includeContent: 'full',
    });
  });

  it('preserves 404 and 500 error contracts', async () => {
    const missingHarness = createHarness({
      getConversationDetail: vi.fn(async () => null),
    });
    const failedHarness = createHarness({
      getConversations: vi.fn(async () => {
        throw new Error('scan failed');
      }),
    });

    const missing = await missingHarness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations/missing',
    });
    const failed = await failedHarness.app.inject({
      method: 'GET',
      url: '/api/telemetry/conversations',
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Conversation not found' });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'Error: scan failed' });
  });
});

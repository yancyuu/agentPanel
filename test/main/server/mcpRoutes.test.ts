import { EventEmitter } from 'node:events';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openMcpStream, registerMcpRoutes } from '../../../src/main/routes/mcpRoutes';
import type {
  AddDeliveryInput,
  AddFeedbackItemInput,
  Task,
} from '../../../src/main/services/team-management/TeamWorkspaceService';

import type { Delivery, FeedbackItem, TaskHistoryEvent } from '@shared/types/team';

const apps: Array<ReturnType<typeof Fastify>> = [];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    teamSlug: 'team-a',
    title: 'Task 1',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    ...overrides,
  };
}

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  let stored = makeTask();
  const readTasks = vi.fn(async () => [stored]);
  const createTask = vi.fn(async (_team: string, payload: { title: string }) =>
    makeTask({ id: 'task-new', title: payload.title })
  );
  const patchTask = vi.fn(async (_team: string, taskId: string, patch: Partial<Task>) => {
    stored = { ...stored, ...patch, id: taskId };
    return stored;
  });
  const addDelivery = vi.fn(async (_team: string, _taskId: string, input: AddDeliveryInput) => {
    const delivery: Delivery = {
      version: (stored.deliveries?.length ?? 0) + 1,
      result: input.result,
      deliveredAt: '2026-01-01T00:00:01.000Z',
    };
    stored = { ...stored, deliveries: [...(stored.deliveries ?? []), delivery] };
    return { task: stored, delivery, skippedFeedbackIds: [] as string[] };
  });
  const addFeedbackItem = vi.fn(
    async (_team: string, _taskId: string, input: AddFeedbackItemInput): Promise<FeedbackItem> => ({
      id: 'f_test',
      text: input.text,
      status: 'open',
      createdAt: '2026-01-01T00:00:01.000Z',
    })
  );
  const appendTaskHistoryEvent = vi.fn(
    async (_team: string, _taskId: string, event: TaskHistoryEvent) => {
      stored = { ...stored, historyEvents: [...(stored.historyEvents ?? []), event] };
      return stored;
    }
  );
  registerMcpRoutes(app, {
    readTasks,
    createTask,
    patchTask,
    addDelivery,
    addFeedbackItem,
    appendTaskHistoryEvent,
    readTeamManifest: vi.fn(async (team: string) => ({ displayName: team })),
  });
  return {
    app,
    readTasks,
    createTask,
    patchTask,
    addDelivery,
    addFeedbackItem,
    appendTaskHistoryEvent,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('MCP routes', () => {
  it('preserves initialize and tool-list JSON-RPC contracts', async () => {
    const { app } = createHarness();

    const initialize = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });

    expect(initialize.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hermit-tasks', version: '1.0.0' },
      },
    });
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_tasks',
      'claim_task',
      'complete_task',
      'list_teams',
      'accept_task',
      'reject_task',
      'list_pending_requests',
      'deliver_task',
      'approve_task',
      'reject_result',
    ]);
  });

  it('executes the three implemented task tools without reshaping content', async () => {
    const harness = createHarness();

    const list = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { team_slug: 'team-a' } },
      },
    });
    const complete = await harness.app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'complete_task',
          arguments: { team_slug: 'team-a', task_id: 'task-1', result: 'done' },
        },
      },
    });

    expect(JSON.parse(list.json().result.content[0].text)).toEqual([makeTask()]);
    const completed = JSON.parse(complete.json().result.content[0].text);
    expect(completed).toMatchObject({ id: 'task-1', status: 'done' });
    // 带 result 时记录为一条 delivery，不再写 patchTask 的 result 字段
    expect(completed.deliveries).toEqual([
      expect.objectContaining({ version: 1, result: 'done' }),
    ]);
    expect(completed.historyEvents).toEqual([
      expect.objectContaining({
        type: 'status_changed',
        from: 'in_progress',
        to: 'completed',
        actor: 'agent',
      }),
    ]);
    expect(harness.addDelivery).toHaveBeenCalledWith('team-a', 'task-1', { result: 'done' });
    expect(harness.patchTask).toHaveBeenCalledWith('team-a', 'task-1', { status: 'done' });
  });

  it('preserves unknown tool, notification and method responses', async () => {
    const { app } = createHarness();

    const unknownTool = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'unknown', arguments: {} },
      },
    });
    const initialized = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    const unknownMethod = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'unknown' },
    });

    expect(unknownTool.json().result).toMatchObject({ isError: true });
    expect(unknownTool.json().result.content[0].text).toBe('Error: Unknown tool: unknown');
    expect(initialized.statusCode).toBe(204);
    expect(unknownMethod.statusCode).toBe(400);
    expect(unknownMethod.json()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('opens and cleans the MCP SSE endpoint handshake', () => {
    vi.useFakeTimers();
    const rawRequest = new EventEmitter();
    const rawReply = { writeHead: vi.fn(), write: vi.fn() };
    const reply = { raw: rawReply, hijack: vi.fn(() => 'hijacked') };

    const result = openMcpStream({
      request: { hostname: '127.0.0.1:5680', raw: rawRequest },
      reply,
    });

    expect(result).toBe('hijacked');
    expect(rawReply.write).toHaveBeenCalledWith(
      'event: endpoint\ndata: {"endpoint":"http://127.0.0.1:5680/mcp"}\n\n'
    );
    expect(vi.getTimerCount()).toBe(1);
    rawRequest.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });
});

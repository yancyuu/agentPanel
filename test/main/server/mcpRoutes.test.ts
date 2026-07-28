import { EventEmitter } from 'node:events';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openMcpStream, registerMcpRoutes } from '../../../src/main/routes/mcpRoutes';

const apps: Array<ReturnType<typeof Fastify>> = [];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const readTasks = vi.fn(async () => [{ id: 'task-1', status: 'todo' }]);
  const patchTask = vi.fn(
    async (_team: string, taskId: string, patch: Record<string, unknown>) => ({
      id: taskId,
      ...patch,
    })
  );
  registerMcpRoutes(app, { readTasks, patchTask });
  return { app, patchTask, readTasks };
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

    expect(JSON.parse(list.json().result.content[0].text)).toEqual([
      { id: 'task-1', status: 'todo' },
    ]);
    expect(JSON.parse(complete.json().result.content[0].text)).toEqual({
      id: 'task-1',
      status: 'done',
      result: 'done',
    });
    expect(harness.patchTask).toHaveBeenCalledWith('team-a', 'task-1', {
      status: 'done',
      result: 'done',
    });
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

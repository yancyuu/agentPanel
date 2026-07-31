import { executeMcpTool, type McpToolContent } from '../services/team-management/mcpTaskTools';

import type {
  AddDeliveryInput,
  AddDeliveryResult,
  AddFeedbackItemInput,
  Task,
} from '../services/team-management/TeamWorkspaceService';
import type { FeedbackItem, TaskHistoryEvent } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

interface McpTaskService {
  readTasks(teamSlug: string): Promise<Task[]>;
  createTask(
    teamSlug: string,
    payload: { title: string; description?: string; assignee?: string | null }
  ): Promise<Task>;
  patchTask(teamSlug: string, taskId: string, patch: Partial<Task>): Promise<Task>;
  addDelivery(
    teamSlug: string,
    taskId: string,
    input: AddDeliveryInput
  ): Promise<AddDeliveryResult>;
  addFeedbackItem(
    teamSlug: string,
    taskId: string,
    input: AddFeedbackItemInput
  ): Promise<FeedbackItem>;
  appendTaskHistoryEvent(teamSlug: string, taskId: string, event: TaskHistoryEvent): Promise<Task>;
}

interface McpStreamRequest {
  hostname: string;
  raw: { on(eventName: 'close', listener: () => void): unknown };
}

interface McpStreamReply {
  raw: {
    writeHead(statusCode: number, headers: Record<string, string>): unknown;
    write(chunk: string): unknown;
  };
  hijack(): unknown;
}

export const MCP_TOOLS = [
  {
    name: 'list_tasks',
    description: '列出指定团队的任务看板',
    inputSchema: {
      type: 'object',
      properties: { team_slug: { type: 'string', description: '团队 slug' } },
      required: ['team_slug'],
    },
  },
  {
    name: 'claim_task',
    description: '认领任务（状态改为 doing）',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
        task_id: { type: 'string', description: '任务 ID' },
      },
      required: ['team_slug', 'task_id'],
    },
  },
  {
    name: 'complete_task',
    description:
      '标记任务完成（状态改为 done），可写入结果摘要（带 result 时会记录为一条交付成果 delivery）',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '团队 slug' },
        task_id: { type: 'string', description: '任务 ID' },
        result: { type: 'string', description: '完成结果摘要（可选，记录为交付成果）' },
      },
      required: ['team_slug', 'task_id'],
    },
  },
  {
    name: 'list_teams',
    description:
      '只读：列出所有可用团队（本地和远程）及能力信息。团队协作后续由总线和任务池承载，agent 不应自行派发。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'accept_task',
    description: '接受来自另一个团队的任务请求。在本地创建任务并通知发起方。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'reject_task',
    description: '拒绝来自另一个团队的任务请求。通知发起方并附原因。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        reason: { type: 'string', description: '拒绝原因（可选）' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'list_pending_requests',
    description: '列出当前团队待处理的任务请求（尚未接受或拒绝的）。',
    inputSchema: {
      type: 'object',
      properties: { team_slug: { type: 'string', description: '团队 slug' } },
      required: ['team_slug'],
    },
  },
  {
    name: 'deliver_task',
    description:
      '交付任务结果。完成任务后调用此工具，将结果作为新版本交付成果提交审核；非首次交付必须提供 summary（本轮变更摘要），并可用 addressed_feedback_ids 标记已处理的反馈条目。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（接收方/执行方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        result: { type: 'string', description: '交付结果描述' },
        summary: { type: 'string', description: '本轮变更摘要（非首次交付时必填）' },
        addressed_feedback_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '本轮交付已处理的反馈条目 id 列表',
        },
      },
      required: ['team_slug', 'dispatch_id', 'result'],
    },
  },
  {
    name: 'approve_task',
    description: '审核通过任务交付。发起方对交付结果满意时调用；存在未处理的反馈条目时会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（发起方/审核方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
      },
      required: ['team_slug', 'dispatch_id'],
    },
  },
  {
    name: 'reject_result',
    description:
      '退回任务交付结果，要求修改。附上反馈意见（会创建一条待处理的反馈条目）。超过 3 次退回需要人工介入。',
    inputSchema: {
      type: 'object',
      properties: {
        team_slug: { type: 'string', description: '你的团队 slug（发起方/审核方）' },
        dispatch_id: { type: 'string', description: '任务派发 ID' },
        feedback: { type: 'string', description: '退回反馈（需要修改的内容）' },
        anchor: {
          type: 'object',
          description:
            '可选定位锚点：{kind:"quote",quote} 引用文本，或 {kind:"hunk",changeKey,hunkIndex,contextHash?} 代码 hunk',
        },
      },
      required: ['team_slug', 'dispatch_id', 'feedback'],
    },
  },
];

export function openMcpStream({
  request,
  reply,
}: {
  request: McpStreamRequest;
  reply: McpStreamReply;
}): unknown {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const endpoint = `http://${request.hostname}/mcp`;
  reply.raw.write(`event: endpoint\ndata: ${JSON.stringify({ endpoint })}\n\n`);
  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 15_000);
  request.raw.on('close', () => clearInterval(keepAlive));
  return reply.hijack();
}

async function runMcpTool(
  service: McpTaskService,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpToolContent> {
  return executeMcpTool(service, toolName, args);
}

export function registerMcpRoutes(app: FastifyInstance, service: McpTaskService): void {
  app.get('/mcp', (request, reply) => openMcpStream({ request, reply }));

  app.post<{
    Body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  }>('/mcp', async (request, reply) => {
    const { id, method, params = {} } = request.body ?? {};
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hermit-tasks', version: '1.0.0' },
        },
      };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }
    if (method === 'tools/call') {
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: await runMcpTool(service, toolName, toolArgs) },
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }
    if (method === 'notifications/initialized') return reply.code(204).send();
    return reply
      .code(400)
      .send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  });
}

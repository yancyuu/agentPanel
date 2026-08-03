import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { AgentBusHttpLogEntry } from '../../features/advanced-connections/main/infrastructure/agentBusHttpLog';

/** 用量/上传相关日志（面板「服务日志」区的文件尾部） */
const USAGE_LOG_FILES = ['conversation-upload.log', 'telemetry-worker.log'] as const;
/** AgentBus 出站 HTTP 交互记录（JSONL，由 AgentBusHttpLogger 写入） */
const AGENTBUS_HTTP_LOG = 'agentbus-http.log';

const DEFAULT_TAIL_LINES = 50;
const MAX_TAIL_LINES = 200;

interface UsageLogRoutesDependencies {
  hermitHome: string;
}

/**
 * GET /api/usage-logs?tail=N —
 * - httpEntries：agentbus-http.log 的出站请求记录（JSONL 解析，最新在前，tail N）；
 * - files：conversation-upload.log / telemetry-worker.log 的最后 N 行（文件缺失返回 missing 空态）。
 * N 默认 50、上限 200；文件名固定白名单。
 */
export function registerUsageLogRoutes(
  app: FastifyInstance,
  dependencies: UsageLogRoutesDependencies
): void {
  app.get<{ Querystring: { tail?: string } }>('/api/usage-logs', async (request) => {
    const requested = Number.parseInt(request.query.tail ?? '', 10);
    const tail =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_TAIL_LINES)
        : DEFAULT_TAIL_LINES;

    const httpLogPath = path.join(dependencies.hermitHome, 'logs', AGENTBUS_HTTP_LOG);
    const httpEntries: AgentBusHttpLogEntry[] = await readFile(httpLogPath, 'utf8')
      .then((raw) =>
        raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line) as AgentBusHttpLogEntry;
            } catch {
              return null;
            }
          })
          .filter((entry): entry is AgentBusHttpLogEntry => entry !== null)
          .slice(-tail)
          .reverse()
      )
      .catch(() => []);

    const files = await Promise.all(
      USAGE_LOG_FILES.map(async (name) => {
        const filePath = path.join(dependencies.hermitHome, 'logs', name);
        try {
          const raw = await readFile(filePath, 'utf8');
          const lines = raw.split('\n').filter((line) => line.trim().length > 0);
          return { name, missing: false, lines: lines.slice(-tail) };
        } catch {
          return { name, missing: true, lines: [] as string[] };
        }
      })
    );
    return { ok: true, tail, httpEntries, files };
  });
}

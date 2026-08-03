import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

/** 用量/上传相关日志（用于面板「用量上报日志」区排查上报是否发出） */
const USAGE_LOG_FILES = ['conversation-upload.log', 'telemetry-worker.log'] as const;

const DEFAULT_TAIL_LINES = 50;
const MAX_TAIL_LINES = 200;

interface UsageLogRoutesDependencies {
  hermitHome: string;
}

/**
 * GET /api/usage-logs?tail=N — 读 ~/.hermit/logs 下用量上报相关日志的最后 N 行
 * （N 默认 50、上限 200；文件名固定白名单，文件缺失返回 missing 空态）。
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
    return { ok: true, tail, files };
  });
}

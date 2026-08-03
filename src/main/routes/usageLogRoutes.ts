import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { AgentBusHttpLogEntry } from '../../features/advanced-connections/main/infrastructure/agentBusHttpLog';

/** 用量/上传相关日志（面板「服务日志」区的文件尾部） */
const USAGE_LOG_FILES = ['conversation-upload.log', 'telemetry-worker.log'] as const;

const LARK_AUDIT_LOG = 'lark-credentials-audit.ndjson';

/** 飞书凭证上报审计记录的敏感字段（如出现一律脱敏；该日志设计上本不含明文 token） */
const LARK_SENSITIVE_KEYS = new Set(['accessToken', 'refreshToken', 'appSecret', 'app_secret']);
const MAX_SCOPE_CHARS = 120;

interface LarkAuditEntry {
  timestamp: string;
  ok: boolean;
  accountCount?: number;
  accounts?: { appId?: string; userOpenId?: string; scope?: string }[];
  error?: string;
  message?: string;
}

function sanitizeLarkEntry(raw: unknown): LarkAuditEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const accounts = Array.isArray(entry.accounts)
    ? entry.accounts.map((account) => {
        const record = (account ?? {}) as Record<string, unknown>;
        for (const key of LARK_SENSITIVE_KEYS) {
          if (key in record) record[key] = '***';
        }
        return {
          appId: typeof record.appId === 'string' ? record.appId : undefined,
          userOpenId: typeof record.userOpenId === 'string' ? record.userOpenId : undefined,
          scope:
            typeof record.scope === 'string'
              ? record.scope.length > MAX_SCOPE_CHARS
                ? `${record.scope.slice(0, MAX_SCOPE_CHARS)}…`
                : record.scope
              : undefined,
        };
      })
    : undefined;
  return {
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    ok: entry.ok === true,
    accountCount: typeof entry.accountCount === 'number' ? entry.accountCount : undefined,
    accounts,
    error: typeof entry.error === 'string' ? entry.error : undefined,
    message: typeof entry.message === 'string' ? entry.message : undefined,
  };
}
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

    const larkAuditPath = path.join(dependencies.hermitHome, 'logs', LARK_AUDIT_LOG);
    const larkEntries: LarkAuditEntry[] = await readFile(larkAuditPath, 'utf8')
      .then((raw) =>
        raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return sanitizeLarkEntry(JSON.parse(line));
            } catch {
              return null;
            }
          })
          .filter((entry): entry is LarkAuditEntry => entry !== null)
          .slice(-tail)
          .reverse()
      )
      .catch(() => []);

    return { ok: true, tail, httpEntries, files, larkEntries };
  });
}

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * AgentBus 出站 HTTP 交互记录器（服务日志）：
 * 包住 fetchImpl，每次出站请求记录一条 JSONL 到 ~/.hermit/logs/agentbus-http.log，
 * 供面板「服务日志」区排查「请求到底发没发出去、服务端回了什么」。
 *
 * 脱敏硬要求：
 * - 不记录任何请求头（天然不含 Authorization）；
 * - body（请求/响应）JSON 中 accessToken/refreshToken/*_token/key/secret/api_key
 *   字段值一律替换为 "***"；非 JSON 文本按 key=value 正则同样脱敏；
 * - summary 截断 500 字符；日志文件超过 2MB 时保留尾部一半重写。
 */

export interface AgentBusHttpLogEntry {
  ts: string;
  method: string;
  /** host + path（不含 query，避免泄漏 poll_secret 等参数） */
  url: string;
  /** HTTP 状态码；0 = 网络错误（未拿到响应） */
  status: number;
  durationMs: number;
  requestSummary?: string;
  responseSummary?: string;
  error?: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 500;
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'access_token',
  'refresh_token',
  'key',
  'secret',
  'api_key',
  'apikey',
]);
const SENSITIVE_PAIR_PATTERN = /(access_?token|refresh_?token|api_?key|secret|key)=([^&\s]+)/giu;

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '***' : redactDeep(item, depth + 1);
  }
  return output;
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

/** JSON 则解析后深度脱敏；非 JSON 按 key=value 正则脱敏（兼容 form 编码 body） */
export function summarizePayloadText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return truncate(JSON.stringify(redactDeep(JSON.parse(trimmed))));
  } catch {
    return truncate(trimmed.replace(SENSITIVE_PAIR_PATTERN, '$1=***'));
  }
}

function urlWithoutQuery(input: string | URL | Request): string {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

export class AgentBusHttpLogger {
  constructor(
    private readonly logPath: string,
    private readonly maxFileBytes: number = MAX_FILE_BYTES
  ) {}

  async record(entry: AgentBusHttpLogEntry): Promise<void> {
    try {
      await mkdir(path.dirname(this.logPath), { recursive: true });
      const size = await stat(this.logPath)
        .then((stats) => stats.size)
        .catch(() => 0);
      if (size > this.maxFileBytes) {
        const raw = await readFile(this.logPath, 'utf8').catch(() => '');
        // 保留尾部一半（按换行对齐，避免截断 JSON 行）
        const tailStart = raw.indexOf('\n', Math.floor(raw.length / 2));
        await writeFile(this.logPath, tailStart > 0 ? raw.slice(tailStart + 1) : raw, 'utf8');
      }
      await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 日志写入失败绝不影响请求本身
    }
  }

  wrapFetch(fetchImpl: typeof fetch): typeof fetch {
    const wrapped = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const startedAt = Date.now();
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = urlWithoutQuery(input);
      const requestSummary =
        typeof init?.body === 'string' && init.body ? summarizePayloadText(init.body) : undefined;
      const base = {
        ts: new Date().toISOString(),
        method,
        url,
        ...(requestSummary ? { requestSummary } : {}),
      };
      try {
        const response = await fetchImpl(input, init);
        const responseSummary = await response
          .clone()
          .text()
          .then((text) => summarizePayloadText(text))
          .catch(() => undefined);
        await this.record({
          ...base,
          status: response.status,
          durationMs: Date.now() - startedAt,
          ...(responseSummary ? { responseSummary } : {}),
        });
        return response;
      } catch (error) {
        await this.record({
          ...base,
          status: 0,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    return wrapped as typeof fetch;
  }
}

export function createAgentBusHttpLogger(options: { hermitHome: string; enabled?: boolean }): {
  wrapFetch(fetchImpl: typeof fetch): typeof fetch;
} {
  if (options.enabled === false) return { wrapFetch: (fetchImpl) => fetchImpl };
  const logger = new AgentBusHttpLogger(path.join(options.hermitHome, 'logs', 'agentbus-http.log'));
  return { wrapFetch: (fetchImpl) => logger.wrapFetch(fetchImpl) };
}

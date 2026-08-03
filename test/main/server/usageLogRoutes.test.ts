import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerUsageLogRoutes } from '../../../src/main/routes/usageLogRoutes';

describe('usage log routes（服务日志）', () => {
  let hermitHome: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'usage-logs-'));
    app = Fastify({ logger: false });
    registerUsageLogRoutes(app, { hermitHome });
  });

  afterEach(async () => {
    await app.close();
    await rm(hermitHome, { recursive: true, force: true });
  });

  it('文件缺失时返回空态（missing + 空 httpEntries）', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/usage-logs' });
    const payload = response.json();
    expect(payload.ok).toBe(true);
    expect(payload.httpEntries).toEqual([]);
    expect(payload.files).toEqual([
      { name: 'conversation-upload.log', missing: true, lines: [] },
      { name: 'telemetry-worker.log', missing: true, lines: [] },
    ]);
  });

  it('agentbus-http.log 解析 JSONL 并最新在前，tail 截断', async () => {
    await mkdir(path.join(hermitHome, 'logs'), { recursive: true });
    const entries = Array.from({ length: 5 }, (_, index) => ({
      ts: `2026-01-01T00:00:0${index}.000Z`,
      method: 'POST',
      url: 'bus.company.test/api/x',
      status: 200,
      durationMs: index,
    }));
    await writeFile(
      path.join(hermitHome, 'logs', 'agentbus-http.log'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') +
        '\n' +
        'not-json-line\n',
      'utf8'
    );
    await writeFile(
      path.join(hermitHome, 'logs', 'conversation-upload.log'),
      'line-1\nline-2\nline-3\n',
      'utf8'
    );

    const response = await app.inject({ method: 'GET', url: '/api/usage-logs?tail=2' });
    const payload = response.json();
    expect(payload.tail).toBe(2);
    // 最新在前 + 非法行被跳过
    expect(payload.httpEntries.map((entry: { durationMs: number }) => entry.durationMs)).toEqual([
      4, 3,
    ]);
    expect(payload.files[0]).toEqual({
      name: 'conversation-upload.log',
      missing: false,
      lines: ['line-2', 'line-3'],
    });
    expect(payload.files[1].missing).toBe(true);
  });

  it('tail 上限 200，非法 tail 回退默认 50', async () => {
    await mkdir(path.join(hermitHome, 'logs'), { recursive: true });
    const capped = await app.inject({ method: 'GET', url: '/api/usage-logs?tail=9999' });
    expect(capped.json().tail).toBe(200);
    const fallback = await app.inject({ method: 'GET', url: '/api/usage-logs?tail=abc' });
    expect(fallback.json().tail).toBe(50);
  });
});

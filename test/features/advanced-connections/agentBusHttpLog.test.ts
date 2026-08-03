import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentBusHttpLogger,
  summarizePayloadText,
} from '@features/advanced-connections/main/infrastructure/agentBusHttpLog';

describe('summarizePayloadText 脱敏与截断', () => {
  it('JSON body 中 token/key/secret 字段值替换为 ***（含嵌套）', () => {
    const summary = summarizePayloadText(
      JSON.stringify({
        refresh_token: 'rt-plain',
        nested: { accessToken: 'at-plain', api_key: 'ak-plain', safe: 'ok' },
      })
    );
    expect(summary).toContain('"refresh_token":"***"');
    expect(summary).toContain('"accessToken":"***"');
    expect(summary).toContain('"api_key":"***"');
    expect(summary).toContain('"safe":"ok"');
    expect(summary).not.toContain('rt-plain');
    expect(summary).not.toContain('at-plain');
    expect(summary).not.toContain('ak-plain');
  });

  it('非 JSON（form 编码）按 key=value 脱敏', () => {
    const summary = summarizePayloadText('poll_secret=abc123&flow_id=f-1');
    expect(summary).toBe('poll_secret=***&flow_id=f-1');
    expect(summary).not.toContain('abc123');
  });

  it('summary 截断 500 字符', () => {
    const summary = summarizePayloadText('x'.repeat(1000));
    expect(summary.length).toBeLessThanOrEqual(501);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('AgentBusHttpLogger', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentbus-http-log-'));
    logPath = path.join(tmpDir, 'logs', 'agentbus-http.log');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('wrapFetch 记录 method/host+path（无 query）/status/durationMs，不含 Authorization', async () => {
    const logger = new AgentBusHttpLogger(logPath);
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const wrapped = logger.wrapFetch(fetchImpl as unknown as typeof fetch);

    await wrapped('https://bus.company.test/api/v1/auth/poll?poll_secret=top-secret', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-access-token' },
      body: JSON.stringify({ access_token: 'plain-token' }),
    });

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.method).toBe('POST');
    expect(entry.url).toBe('bus.company.test/api/v1/auth/poll');
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.requestSummary).toContain('"access_token":"***"');
    // 绝不出现 Authorization 头值 / query 里的 secret
    expect(JSON.stringify(entry)).not.toContain('secret-access-token');
    expect(JSON.stringify(entry)).not.toContain('top-secret');
    expect(JSON.stringify(entry)).not.toContain('plain-token');
  });

  it('网络错误记录 status 0 与 error 文案', async () => {
    const logger = new AgentBusHttpLogger(logPath);
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND gw');
    });
    const wrapped = logger.wrapFetch(fetchImpl as unknown as typeof fetch);

    await expect(wrapped('https://bus.company.test/api/x')).rejects.toThrow('ENOTFOUND');
    const entry = JSON.parse((await readFile(logPath, 'utf8')).trim());
    expect(entry.status).toBe(0);
    expect(entry.error).toContain('ENOTFOUND');
  });

  it('文件超过上限时截断保留尾部', async () => {
    const logger = new AgentBusHttpLogger(logPath, 200);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      logPath,
      Array.from({ length: 20 }, (_, index) =>
        JSON.stringify({ n: index, pad: 'xxxxxxxxxxxxxxxxxxxx' })
      ).join('\n') + '\n',
      'utf8'
    );
    await logger.record({
      ts: '2026-01-01T00:00:00.000Z',
      method: 'GET',
      url: 'bus.company.test/api/x',
      status: 200,
      durationMs: 1,
    });

    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n');
    // 旧内容被截断到尾部一半，新行完整保留且每行仍是合法 JSON
    expect(lines.length).toBeLessThan(21);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines.at(-1)!).url).toBe('bus.company.test/api/x');
    // 截断后体积明显小于原文件（~700B）
    expect((await stat(logPath)).size).toBeLessThan(700);
  });
});

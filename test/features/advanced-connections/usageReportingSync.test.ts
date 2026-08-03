import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readUsageReportingEnabled,
  writeUsageReportingEnabled,
} from '@features/advanced-connections/renderer/services/usageReportingSync';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('usageReportingSync（settings.json taskBus.telemetry.enabled 读写）', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/settings/task-bus' && !init?.method) {
          return jsonResponse({
            enabled: true,
            telemetry: { enabled: false, platform: 'claudecode', uploadProviders: ['codex'] },
          });
        }
        if (url === '/api/settings/task-bus' && init?.method === 'PUT') {
          return jsonResponse({ ok: true });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('读取 telemetry.enabled（缺失视为未开启）', async () => {
    expect(await readUsageReportingEnabled()).toBe(false);
    // 路由返回的是 taskBus 本体（{ enabled, telemetry } 结构）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ enabled: true, telemetry: { enabled: true } }))
    );
    expect(await readUsageReportingEnabled()).toBe(true);
  });

  it('写入时保留 taskBus 其他字段，仅翻转 telemetry.enabled（PUT 内联动 worker 启停）', async () => {
    await writeUsageReportingEnabled(true);
    const putCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall?.[1]?.body));
    expect(body).toEqual({
      enabled: true,
      telemetry: { enabled: true, platform: 'claudecode', uploadProviders: ['codex'] },
    });

    await writeUsageReportingEnabled(false);
    const putCalls = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(2);
    expect(JSON.parse(String(putCalls[1]?.[1]?.body)).telemetry.enabled).toBe(false);
  });

  it('PUT 失败时抛出服务端错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'PUT'
          ? jsonResponse({ error: '写入失败' }, 500)
          : jsonResponse({ telemetry: {} })
      )
    );
    await expect(writeUsageReportingEnabled(true)).rejects.toThrow('写入失败');
  });
});

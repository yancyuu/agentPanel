import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageLogsCard } from '@features/advanced-connections/renderer/ui/UsageLogsCard';

const RESPONSE = {
  ok: true,
  tail: 10,
  httpEntries: [
    {
      ts: '2026-08-02T10:00:01.000Z',
      method: 'POST',
      url: 'bus.company.test/api/v1/token-distribution-v3/aliyun/discover',
      status: 200,
      durationMs: 123,
      requestSummary: '{"region_id":"cn-shenzhen"}',
      responseSummary: '{"discovery_id":"d-1"}',
    },
    {
      ts: '2026-08-02T10:00:00.000Z',
      method: 'GET',
      url: 'bus.company.test/api/v1/auth/me',
      status: 401,
      durationMs: 45,
    },
    {
      ts: '2026-08-02T09:59:59.000Z',
      method: 'POST',
      url: 'bus.company.test/api/v1/report/messages',
      status: 0,
      durationMs: 30000,
      error: 'fetch failed',
    },
  ],
  files: [{ name: 'conversation-upload.log', missing: false, lines: ['upload ok'] }],
  larkLines: ['{"timestamp":"2026-08-02T10:00:02.000Z","ok":true,"accountCount":2}'],
};

describe('UsageLogsCard（服务日志）', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }))
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('展示请求记录（方法/路径/状态色/耗时）与文件尾部，空态与刷新可用', async () => {
    const fetchMock = vi.mocked(fetch);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<UsageLogsCard />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('服务日志');
    const entries = host.querySelectorAll('[data-testid="service-log-entry"]');
    expect(entries).toHaveLength(3);
    // 状态着色：2xx 绿 / 4xx 黄 / 网络错误灰
    expect(entries[0]?.textContent).toContain('POST');
    expect(entries[0]?.textContent).toContain('200');
    expect(entries[0]?.textContent).toContain('123ms');
    expect(entries[0]?.querySelector('span.rounded-full')?.className).toContain('emerald');
    expect(entries[1]?.querySelector('span.rounded-full')?.className).toContain('amber');
    expect(entries[2]?.textContent).toContain('网络错误');
    // 展开内容（details 内含请求/返回摘要）
    expect(entries[0]?.textContent).toContain('请求：{"region_id":"cn-shenzhen"}');
    expect(entries[0]?.textContent).toContain('返回：{"discovery_id":"d-1"}');
    // 文件尾部与空态
    expect(host.querySelector('[data-testid="usage-log-tail:conversation-upload.log"]')).not.toBeNull();
    // lark 区：标题即文件名，展示脱敏 ndjson 原文
    expect(host.textContent).toContain('lark-credentials-audit.ndjson');
    expect(host.textContent).not.toContain('飞书授权上报');
    expect(host.querySelector('[data-testid="usage-log-lark"]')?.textContent).toContain(
      '"accountCount":2'
    );

    // 刷新按钮触发重新拉取
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="刷新服务日志"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);

    act(() => root.unmount());
  });

  it('无请求记录时显示空态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          tail: 10,
          httpEntries: [],
          files: [{ name: 'conversation-upload.log', missing: true, lines: [] }],
          larkLines: [],
        })
      )
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<UsageLogsCard />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="service-log-empty"]')).not.toBeNull();
    expect(host.textContent).toContain('暂无出站请求记录');
    act(() => root.unmount());
  });
});

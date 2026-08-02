import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskBusSection } from '@renderer/components/settings/sections/TaskBusSection';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const taskBusSettings = {
  enabled: false,
  collaboration: false,
  telemetry: { enabled: false, platform: 'claudecode' },
};

const telemetryStatus = {
  connected: true,
  lastScan: null,
  sessions: 3,
  messages: 10,
  tokensIn: 100,
  tokensOut: 200,
  cacheRead: 0,
  cacheCreation: 0,
  totalTokens: 300,
  activeDays: 1,
  hourly: [],
  projects: [],
  workSecondsByDay: {},
};

function stubFetch() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/telemetry/status')) return jsonResponse(telemetryStatus);
    if (url.endsWith('/api/settings/task-bus') && method === 'GET') return jsonResponse(taskBusSettings);
    if (url.endsWith('/api/settings/task-bus') && method === 'PUT') return jsonResponse({ ok: true });
    if (url.endsWith('/api/telemetry/scan')) {
      return jsonResponse({ ok: true, sessions: 3, messages: 10, totalTokens: 300 });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

async function renderSection(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TaskBusSection />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

function clickButton(host: HTMLElement, text: string): void {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TaskBusSection usage 控制', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('开始采集：PUT 写入 telemetry.enabled=true 并显示结果反馈', async () => {
    const calls = stubFetch();
    const host = await renderSection();

    expect(host.textContent).toContain('已停止');
    clickButton(host, '开始采集');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toMatchObject({ telemetry: { enabled: true } });
    const outcome = host.querySelector('[data-testid="usage-control-outcome"]');
    expect(outcome?.textContent).toContain('已开始采集');
  });

  it('立即上报：调用 /api/telemetry/scan 并展示上报摘要', async () => {
    const calls = stubFetch();
    taskBusSettings.telemetry.enabled = true;
    const host = await renderSection();

    expect(host.textContent).toContain('采集中');
    clickButton(host, '立即上报');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls.some((call) => call.url.endsWith('/api/telemetry/scan') && call.method === 'POST')).toBe(
      true
    );
    const outcome = host.querySelector('[data-testid="usage-control-outcome"]');
    expect(outcome?.textContent).toContain('本次上报完成');
    expect(outcome?.textContent).toContain('会话 3');
    expect(outcome?.textContent).toContain('消息 10');
    taskBusSettings.telemetry.enabled = false;
  });

  it('团队协作开关：勾选后 PUT collaboration=true 并显示状态', async () => {
    const calls = stubFetch();
    const host = await renderSection();

    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toMatchObject({ collaboration: true });
    const outcome = host.querySelector('[data-testid="usage-control-outcome"]');
    expect(outcome?.textContent).toContain('团队协作已启用');
  });
});

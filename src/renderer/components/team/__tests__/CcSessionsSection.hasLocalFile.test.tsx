/**
 * CcSessionsSection — cc-only session expand regression (#20).
 *
 * A Feishu listening session with no local Claude JSONL yet is listed so the
 * user sees it is listening. Expanding it now fetches the team session detail
 * endpoint, which falls back to cc-connect history when local JSONL is absent.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CcSessionsSection } from '../CcSessionsSection';

import type { CcSession } from '@shared/types';

const getSessionDetail = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getSessionDetail,
    },
  },
}));

function ccOnlySession(overrides: Partial<CcSession> = {}): CcSession {
  return {
    id: 'oc_feishu_only',
    title: 'feishu',
    projectId: 'team-x',
    sessionKey: 'oc_feishu_only',
    platform: 'feishu',
    userName: null,
    chatName: '飞书测试群',
    active: true,
    live: true,
    historyCount: 0,
    createdAt: '2026-06-14T10:00:00Z',
    updatedAt: '2026-06-14T10:00:00Z',
    lastMessage: null,
    hasLocalFile: false,
    ...overrides,
  };
}

async function renderSection(props: {
  sessions: CcSession[];
  loading?: boolean;
  error?: string | null;
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(CcSessionsSection, {
        teamName: 'team-x',
        sessions: props.sessions,
        loading: props.loading ?? false,
        error: props.error ?? null,
      } as never)
    );
    await Promise.resolve();
  });
  return { host, root };
}

describe('CcSessionsSection — cc-only session expand (#20)', () => {
  beforeEach(() => {
    getSessionDetail.mockReset();
    getSessionDetail.mockResolvedValue({
      id: 'oc_feishu_only',
      name: 'feishu',
      sessionKey: 'oc_feishu_only',
      agentType: 'claude-code',
      active: true,
      live: true,
      historyCount: 0,
      createdAt: '2026-06-14T10:00:00Z',
      updatedAt: '2026-06-14T10:00:00Z',
      platform: 'feishu',
      history: [],
    });
    document.body.innerHTML = '';
  });

  it('fetches detail for a cc-only session so cc-connect history can render', async () => {
    const { host } = await renderSection({ sessions: [ccOnlySession()] });

    // The row header is a button carrying the session label.
    const rowButton = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('飞书测试群')
    );
    expect(rowButton, 'session row rendered').toBeTruthy();

    await act(async () => {
      rowButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('监听中，暂无本地历史');
    expect(host.textContent).not.toContain('会话文件已不存在');
    expect(getSessionDetail).toHaveBeenCalledTimes(1);
    expect(getSessionDetail).toHaveBeenCalledWith('team-x', 'oc_feishu_only', expect.any(Number));
  });

  it('fetches local detail normally for a local-file session', async () => {
    const { host } = await renderSection({ sessions: [ccOnlySession({ hasLocalFile: true })] });

    const rowButton = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('飞书测试群')
    );
    expect(rowButton, 'session row rendered').toBeTruthy();

    await act(async () => {
      rowButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A local-file session must still go through the local detail endpoint.
    expect(getSessionDetail).toHaveBeenCalledTimes(1);
    expect(getSessionDetail).toHaveBeenCalledWith('team-x', 'oc_feishu_only', expect.any(Number));
  });
});

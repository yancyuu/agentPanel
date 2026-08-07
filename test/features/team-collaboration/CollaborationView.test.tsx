import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@features/collaborative-workbench/renderer', () => ({
  TaskInputPicker: () => <div />,
}));

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      teams: [],
      fetchTeams: vi.fn(),
      openInboxTab: vi.fn(),
    });
  useStore.getState = () => ({
    fetchTeams: vi.fn(),
    openInboxTab: vi.fn(),
  });
  return { useStore };
});

import { CollaborationView } from '../../../src/features/team-collaboration/renderer/CollaborationView';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const teamsPayload = [
  { slug: 'squad-a', displayName: '调研组', memberTeamSlugs: ['agent-a', 'agent-b'] },
  { slug: 'squad-b', displayName: '运营组', memberTeamSlugs: ['agent-c', 'agent-d'] },
];

const detailPayload = {
  team: { slug: 'squad-a', displayName: '调研组', description: '' },
  members: [
    { teamSlug: 'agent-a', displayName: '产品经理' },
    { teamSlug: 'agent-b', displayName: '研究员' },
  ],
  runs: [
    {
      id: 'run-1234567890',
      title: '调研亚马逊开店',
      phase: 'executing',
      captainTeamSlug: 'agent-a',
      members: [
        { teamSlug: 'agent-a', displayName: '产品经理' },
        { teamSlug: 'agent-b', displayName: '研究员' },
      ],
      ballots: [
        {
          memberTeamSlug: 'agent-b',
          memberDisplayName: '研究员',
          nomineeTeamSlug: 'agent-a',
          statement: '我先梳理站点差异。',
          suggestedContribution: '资料收集',
        },
      ],
      workItems: [
        {
          id: 'wi-1',
          title: '收集费用数据',
          description: '各站点佣金',
          assigneeDisplayName: '研究员',
          status: 'completed',
        },
      ],
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

describe('CollaborationView 视觉结构', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/collaboration/teams/squad-a')) return jsonResponse(detailPayload);
        return jsonResponse(teamsPayload);
      })
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('顶部是文字 tab（选中态有指示线 class），进度是 stepper 节点而非格子', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<CollaborationView />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // tab 条：选中小队带 indigo 指示线 class
    const tabs = host.querySelectorAll('nav[aria-label="小队切换"] button');
    expect(tabs.length).toBe(2);
    expect(tabs[0]?.className).toContain('border-indigo-500');
    expect(tabs[1]?.className).toContain('border-transparent');

    // stepper：6 个阶段节点，无 grid 格子
    const steps = host.querySelectorAll('[data-testid="run-step"]');
    expect(steps.length).toBe(6);
    expect(host.querySelector('[data-testid="run-stepper"]')).not.toBeNull();

    // 圆桌时间线：提名/建议承担是弱化元信息
    expect(host.textContent).toContain('提名 产品经理');
    expect(host.textContent).toContain('建议承担：资料收集');

    act(() => root.unmount());
  });
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { WorkflowTimeline } from '@renderer/components/team/dialogs/StatusHistoryTimeline';

import type { TaskHistoryEvent } from '@shared/types';

function renderTimeline(events: TaskHistoryEvent[]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<WorkflowTimeline events={events} />);
  });
  return host;
}

describe('WorkflowTimeline', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders Chinese copy for review lifecycle events', () => {
    const host = renderTimeline([
      {
        id: 'e1',
        type: 'task_created',
        status: 'pending',
        timestamp: '2026-07-30T09:00:00.000Z',
        actor: 'alice',
      },
      {
        id: 'e2',
        type: 'review_requested',
        from: 'none',
        to: 'review',
        reviewer: 'bob',
        timestamp: '2026-07-30T10:00:00.000Z',
      },
      {
        id: 'e3',
        type: 'review_changes_requested',
        from: 'review',
        to: 'needsFix',
        note: '还有两处要改',
        timestamp: '2026-07-30T11:00:00.000Z',
      },
      {
        id: 'e4',
        type: 'review_approved',
        from: 'review',
        to: 'approved',
        timestamp: '2026-07-31T09:00:00.000Z',
      },
      {
        id: 'e5',
        type: 'status_changed',
        from: 'pending',
        to: 'completed',
        timestamp: '2026-07-31T10:00:00.000Z',
      },
    ]);

    expect(host.textContent).toContain('创建为');
    expect(host.textContent).toContain('请求评审');
    expect(host.textContent).toContain('要求修改');
    expect(host.textContent).toContain('已批准');
    expect(host.textContent).toContain('还有两处要改');
    expect(host.textContent).not.toContain('Review requested');
    expect(host.textContent).not.toContain('Changes requested');
  });

  it('shows an empty-state message in Chinese when there are no events', () => {
    const host = renderTimeline([]);
    expect(host.textContent).toContain('暂无流程记录');
  });
});

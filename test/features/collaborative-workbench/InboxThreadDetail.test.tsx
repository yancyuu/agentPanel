import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxThreadsState } from '../../../src/features/collaborative-workbench/renderer/hooks/useInboxThreads';
import type { InboxThreadProjection } from '../../../src/features/collaborative-workbench/renderer/utils/inboxThreadProjection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let composerProps: Record<string, unknown> | null = null;

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock('@renderer/components/team/messages/MessageComposer', () => ({
  MessageComposer: (props: Record<string, unknown>) => {
    composerProps = props;
    return (
      <button
        type="button"
        onClick={() =>
          (props.onSend as (recipient: string, text: string, summary?: string) => void)(
            'alice',
            '第一封私信',
            '第一封私信'
          )
        }
      >
        模拟发送
      </button>
    );
  },
}));

import { InboxThreadDetail } from '../../../src/features/collaborative-workbench/renderer/ui/InboxThreadDetail';

const mounted: { root: ReturnType<typeof createRoot>; host: HTMLDivElement }[] = [];

function createInbox(sendMessage = vi.fn()): InboxThreadsState {
  return {
    threads: [],
    selectedThread: null,
    selectedKey: null,
    query: '',
    setQuery: vi.fn(),
    teamFilter: 'all',
    setTeamFilter: vi.fn(),
    teamOptions: [],
    recipientOptions: [],
    createThread: vi.fn(),
    selectThread: vi.fn(),
    refresh: vi.fn(),
    loading: false,
    members: [],
    isTeamAlive: true,
    sending: false,
    sendError: null,
    sendWarning: null,
    sendDebugDetails: null,
    lastResult: null,
    navigationRequestAt: null,
    sendMessage,
  };
}

function renderDetail(thread: InboxThreadProjection, inbox: InboxThreadsState): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<InboxThreadDetail thread={thread} inbox={inbox} onBack={vi.fn()} />);
  });
  mounted.push({ root, host });
  return host;
}

afterEach(() => {
  composerProps = null;
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

describe('InboxThreadDetail mail interaction', () => {
  it('uses a full mail composer for the first private message and preserves its subject', () => {
    const sendMessage = vi.fn();
    const thread: InboxThreadProjection = {
      key: 'team-a:conversation-new',
      teamName: 'team-a',
      teamDisplayName: '测试',
      participant: 'alice',
      conversationId: 'conversation-new',
      subject: '与 alice 的私信',
      preview: '新私信',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: [],
      unread: false,
      draft: true,
    };
    const host = renderDetail(thread, createInbox(sendMessage));

    expect(host.textContent).toContain('新私信');
    expect(host.textContent).toContain('收件人');
    expect(host.textContent).not.toContain('0 封往来');
    expect(composerProps).toMatchObject({ mailMode: true, minRows: 10, sendLabel: '发送私信' });

    const subject = host.querySelector<HTMLInputElement>('[placeholder="填写主题（可选）"]');
    act(() => {
      if (!subject) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(subject, '季度汇报');
      subject.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '模拟发送')
        ?.click();
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'alice',
      '第一封私信',
      '季度汇报',
      undefined,
      undefined,
      undefined,
      undefined
    );
  });
});

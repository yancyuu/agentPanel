import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendTeamMessageMock, sendMessageErrorState, sendingMessageState, messagesState } = vi.hoisted(
  () => ({
    sendTeamMessageMock: vi.fn(() => Promise.resolve()),
    sendMessageErrorState: { value: null as string | null },
    sendingMessageState: { value: false },
    messagesState: {
      value: [] as {
        messageId?: string;
        from: string;
        text: string;
        timestamp: string;
        conversationId?: string;
        read: boolean;
      }[],
    },
  })
);

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sendTeamMessage: sendTeamMessageMock,
      sendingMessage: sendingMessageState.value,
      sendMessageError: sendMessageErrorState.value,
    }),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamMessages: () => messagesState.value,
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AgentTuningDialog } from '@renderer/components/team/members/AgentTuningDialog';

import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: '产品经理',
  status: 'active',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
};

function renderDialog(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AgentTuningDialog open teamName="team-a" member={member} onClose={() => undefined} />);
  });
  return host;
}

function typeAndSend(host: HTMLElement, text: string): void {
  const textarea = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, text);
  act(() => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const sendButton = [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '发送'
  )!;
  act(() => {
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AgentTuningDialog 发送与等待状态', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    messagesState.value = [];
    sendingMessageState.value = false;
    sendMessageErrorState.value = null;
    sendTeamMessageMock.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('发送中显示「正在发送」提示，提交带 tuning conversationId', async () => {
    sendingMessageState.value = true;
    const host = renderDialog();
    expect(host.querySelector('[data-testid="tuning-sending-empty"]')).not.toBeNull();
    expect(host.textContent).toContain('正在发送…');

    sendingMessageState.value = false;
    typeAndSend(host, '回答再简短一点');
    expect(sendTeamMessageMock).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        member: '产品经理',
        conversationId: 'tuning:team-a:产品经理',
        replyToConversationId: 'tuning:team-a:产品经理',
        to: '产品经理',
        source: 'user_sent',
      })
    );
  });

  it('最后一条是用户消息时显示「正在输入…」typing 指示，agent 回复后消失', () => {
    messagesState.value = [
      {
        messageId: 'm-1',
        from: 'user',
        text: '回答再简短一点',
        timestamp: '2026-08-02T10:00:00.000Z',
        conversationId: 'tuning:team-a:产品经理',
        read: true,
      },
    ];
    const host = renderDialog();
    expect(host.querySelector('[data-testid="tuning-typing"]')).not.toBeNull();
    expect(host.textContent).toContain('正在输入…');

    messagesState.value = [
      ...messagesState.value,
      {
        messageId: 'm-2',
        from: '产品经理',
        text: '好的，之后回答控制在三句话以内。',
        timestamp: '2026-08-02T10:00:05.000Z',
        conversationId: 'tuning:team-a:产品经理',
        read: true,
      },
    ];
    const host2 = renderDialog();
    expect(host2.querySelector('[data-testid="tuning-typing"]')).toBeNull();
  });

  it('发送失败展示错误', () => {
    sendMessageErrorState.value = '发送失败：会话不可用';
    const host = renderDialog();
    expect(host.textContent).toContain('发送失败：会话不可用');
  });
});

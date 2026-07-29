import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxThreadList } from '../../../src/features/collaborative-workbench/renderer/ui/InboxThreadList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: ReturnType<typeof createRoot>; host: HTMLDivElement }[] = [];

function renderList(onCreateThread = vi.fn()): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <InboxThreadList
        threads={[]}
        selectedKey={null}
        query=""
        onQueryChange={vi.fn()}
        teamFilter="all"
        onTeamFilterChange={vi.fn()}
        teamOptions={[['assistant-1', '测试']]}
        recipientOptions={[
          {
            teamName: 'assistant-1',
            teamDisplayName: '测试',
            memberName: '测试员工',
          },
        ]}
        onCreateThread={onCreateThread}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        loading={false}
      />
    );
  });
  mounted.push({ root, host });
  return host;
}

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

describe('InboxThreadList', () => {
  it('starts a first conversation directly from the inbox', () => {
    const onCreateThread = vi.fn();
    const host = renderList(onCreateThread);

    const newConversation = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('写私信')
    );
    act(() => newConversation?.click());

    const recipient = host.querySelector<HTMLSelectElement>('[aria-label="选择数字员工"]');
    expect(recipient).not.toBeNull();
    act(() => {
      if (!recipient) return;
      recipient.value = 'assistant-1\u0000测试员工';
      recipient.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const start = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('新建私信')
    );
    act(() => start?.click());

    expect(onCreateThread).toHaveBeenCalledWith('assistant-1', '测试员工');
  });

  it('uses one compact toolbar without repeating the mail heading', () => {
    const host = renderList();

    expect(host.textContent).not.toContain('每封邮件都是一个可持续回复的对话');
    expect(host.querySelector('[placeholder="搜索发件人、主题或正文"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="按团队筛选对话"]')).not.toBeNull();
  });
});

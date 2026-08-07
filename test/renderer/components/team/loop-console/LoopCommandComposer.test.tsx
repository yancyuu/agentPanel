import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoopCommandComposer } from '@renderer/components/team/loop-console/LoopCommandComposer';

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { capabilityPacks: [] }) => unknown) =>
    selector({ capabilityPacks: [] }),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: ({ id, placeholder }: { id: string; placeholder?: string }) =>
    React.createElement('textarea', { id, placeholder, readOnly: true }),
}));

vi.mock('@renderer/components/team/loop-console/useLoopCommandSuggestions', () => ({
  useLoopCommandSuggestions: () => ({
    mentionSuggestions: [],
    teamSuggestions: [],
    taskSuggestions: [],
    commandSuggestions: [],
    leadRecipient: 'hermit开发',
  }),
}));

describe('LoopCommandComposer', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders compact Loop console copy without dense explanatory badges', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(LoopCommandComposer, {
          teamName: 'atlas-hq',
          members: [],
          isTeamAlive: true,
          onSubmit: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    // Compact header renders the `cmd` badge (not the legacy "Loop Console" label).
    expect(host.textContent).toContain('cmd');
    expect(host.textContent).toContain('发送给 Lead');
    expect(host.textContent).not.toContain('写入消息看板并下发给 Lead');
    expect(host.textContent).not.toContain('创建/复用 Loop 会话并发送初始指令');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

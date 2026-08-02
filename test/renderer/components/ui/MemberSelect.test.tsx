import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

import { MemberSelect } from '@renderer/components/ui/MemberSelect';

import type { ResolvedTeamMember } from '@shared/types';

const synthesizedMember: ResolvedTeamMember = {
  name: '产品经理',
  agentId: 'claudecode',
  agentType: 'claudecode',
  role: 'lead',
  color: 'blue',
  status: 'idle',
  currentTaskId: null,
  taskCount: 1,
  lastActiveAt: null,
  messageCount: 0,
};

function renderSelect(members: ResolvedTeamMember[], value: string | null): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<MemberSelect members={members} value={value} onChange={() => undefined} allowUnassigned />);
  });
  return host;
}

describe('MemberSelect v2 团队匹配', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('owner=displayName 在合成成员下显示为已分配（不显示未分配）', () => {
    const host = renderSelect([synthesizedMember], '产品经理');
    const trigger = host.querySelector('button[role="combobox"]');
    expect(trigger?.textContent).toContain('产品经理');
    expect(trigger?.textContent).not.toContain('未分配');
  });

  it('成员列表为空时显示未分配（bug 场景对照）', () => {
    const host = renderSelect([], '产品经理');
    const trigger = host.querySelector('button[role="combobox"]');
    expect(trigger?.textContent).not.toContain('未分配');
    // 空 roster 下 value 匹配不到成员，回退 placeholder
    expect(trigger?.textContent).toContain('选择成员');
  });
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getTeamAssets: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTeamAssets: hoisted.getTeamAssets,
    },
  },
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TeamAssetsSection } from '@renderer/components/team/assets/TeamAssetsSection';

async function renderSection(teamName: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TeamAssetsSection teamName={teamName} />);
    await Promise.resolve();
  });
  return host;
}

describe('TeamAssetsSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('展示 living specs 与最近沉淀记录', async () => {
    hoisted.getTeamAssets.mockResolvedValue({
      ok: true,
      specs: [{ id: 'weekly-report', title: '周报生成工作流', updatedAt: '2026-08-01T09:00:00Z' }],
      archives: [
        {
          id: '2026-08-01-add-weekly-report',
          archivedAt: '2026-08-01T09:00:00Z',
          operations: ['ADDED'],
        },
      ],
    });

    const host = await renderSection('team-a');
    expect(hoisted.getTeamAssets).toHaveBeenCalledWith('team-a');
    expect(host.textContent).toContain('周报生成工作流');
    expect(host.textContent).toContain('Living specs');
    expect(host.textContent).toContain('最近沉淀记录');
    expect(host.textContent).toContain('2026-08-01-add-weekly-report');
    expect(host.textContent).toContain('ADDED');
  });

  it('无产物时展示空态引导', async () => {
    hoisted.getTeamAssets.mockResolvedValue({ ok: true, specs: [], archives: [] });
    const host = await renderSection('team-a');
    expect(host.textContent).toContain('还没有沉淀的产物');
    expect(host.textContent).toContain('沉淀一下');
  });

  it('读取失败时展示错误', async () => {
    hoisted.getTeamAssets.mockRejectedValue(new Error('team not found'));
    const host = await renderSection('team-a');
    expect(host.textContent).toContain('team not found');
  });
});

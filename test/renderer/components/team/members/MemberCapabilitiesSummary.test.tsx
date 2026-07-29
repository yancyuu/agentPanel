/* eslint-disable security/detect-object-injection -- test fixtures use controlled project-path keys */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';
import type { InstalledMcpEntry, SkillCatalogItem } from '@shared/types/extensions';

const testState = vi.hoisted(() => ({
  teamDataByName: {
    'demo-team': {
      config: { projectPath: '/workspace/team' },
    },
  } as Record<string, { config: { projectPath?: string } }>,
  skillsProjectCatalogByProjectPath: {} as Record<string, SkillCatalogItem[]>,
  skillsCatalogLoadingByProjectPath: {} as Record<string, boolean>,
  skillsCatalogErrorByProjectPath: {} as Record<string, string | null>,
  mcpInstalledServersByProjectPath: {} as Record<string, InstalledMcpEntry[]>,
  fetchSkillsCatalog: vi.fn(() => Promise.resolve()),
  mcpFetchInstalled: vi.fn(() => Promise.resolve()),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof testState) => unknown) => selector(testState),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: (state: typeof testState, teamName: string) =>
    state.teamDataByName[teamName] ?? null,
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));

import { MemberCapabilitiesSummary } from '@renderer/components/team/members/MemberCapabilitiesSummary';

function makeSkill(
  id: string,
  name: string,
  description: string,
  scope: SkillCatalogItem['scope'] = 'project'
): SkillCatalogItem {
  return {
    id,
    sourceType: 'filesystem',
    name,
    description,
    folderName: name.toLowerCase(),
    scope,
    rootKind: 'hermit',
    projectRoot: '/workspace/member',
    discoveryRoot: '/workspace/member/.claude/skills',
    skillDir: `/workspace/member/.claude/skills/${name.toLowerCase()}`,
    skillFile: `/workspace/member/.claude/skills/${name.toLowerCase()}/SKILL.md`,
    metadata: {},
    invocationMode: 'auto',
    flags: { hasScripts: false, hasReferences: false, hasAssets: false },
    isValid: true,
    issues: [],
    modifiedAt: 1,
  };
}

async function renderSummary(
  member: ResolvedTeamMember,
  open = true
): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MemberCapabilitiesSummary open={open} member={member} teamName="demo-team" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

describe('MemberCapabilitiesSummary', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    testState.teamDataByName = {
      'demo-team': { config: { projectPath: '/workspace/team' } },
    };
    testState.skillsProjectCatalogByProjectPath = {};
    testState.skillsCatalogLoadingByProjectPath = {};
    testState.skillsCatalogErrorByProjectPath = {};
    testState.mcpInstalledServersByProjectPath = {};
    testState.fetchSkillsCatalog.mockClear();
    testState.mcpFetchInstalled.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not fetch capabilities before the member dialog opens', async () => {
    const member = {
      name: 'worker',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      cwd: '/workspace/member',
    } as ResolvedTeamMember;

    const { root } = await renderSummary(member, false);

    expect(testState.fetchSkillsCatalog).not.toHaveBeenCalled();
    expect(testState.mcpFetchInstalled).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the member cwd, fetches capabilities, dedupes skills, and marks built-in MCP', async () => {
    const memberPath = '/workspace/member';
    testState.skillsProjectCatalogByProjectPath[memberPath] = [
      makeSkill('skill-1', 'Review', '审查代码变更'),
      makeSkill('skill-2', 'review', '重复名称应被隐藏'),
      makeSkill('skill-3', 'Release', '准备发布说明'),
    ];
    testState.mcpInstalledServersByProjectPath[memberPath] = [
      { name: 'hermit-tasks', scope: 'project', transport: 'sse' },
      { name: 'context7', scope: 'user', transport: 'stdio' },
    ];
    const member = {
      name: 'worker',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      cwd: memberPath,
    } as ResolvedTeamMember;

    const { host, root } = await renderSummary(member);

    expect(testState.fetchSkillsCatalog).toHaveBeenCalledWith(memberPath);
    expect(testState.mcpFetchInstalled).toHaveBeenCalledWith(memberPath);
    expect(host.textContent).toContain(`生效项目： ${memberPath}`);
    expect(host.querySelectorAll('[aria-label="生效 Skills"] li')).toHaveLength(2);
    expect(host.textContent).toContain('审查代码变更');
    expect(host.textContent).not.toContain('重复名称应被隐藏');
    expect(host.textContent).toContain('hermit-tasks');
    expect(host.textContent).toContain('Hermit 内置');
    expect(host.textContent).not.toContain('尚未检测到 Hermit 任务 MCP');
    expect(host.querySelectorAll('button')).toHaveLength(0);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('falls back to the team project path and truthfully warns when Hermit MCP is absent', async () => {
    const teamPath = '/workspace/team';
    testState.skillsProjectCatalogByProjectPath[teamPath] = [
      makeSkill('skill-team', 'Team Briefing', '读取团队上下文'),
    ];
    testState.mcpInstalledServersByProjectPath[teamPath] = [
      { name: 'filesystem', scope: 'project', transport: 'stdio' },
    ];
    const member = {
      name: 'lead',
      status: 'active',
      currentTaskId: null,
      taskCount: 0,
      lastActiveAt: null,
      messageCount: 0,
      agentType: 'lead',
    } as ResolvedTeamMember;

    const { host, root } = await renderSummary(member);

    expect(testState.fetchSkillsCatalog).toHaveBeenCalledWith(teamPath);
    expect(testState.mcpFetchInstalled).toHaveBeenCalledWith(teamPath);
    expect(host.textContent).toContain(`生效项目： ${teamPath}`);
    expect(host.textContent).toContain('Team Briefing');
    expect(host.textContent).toContain('尚未检测到 Hermit 任务 MCP');
    expect(host.textContent).toContain('filesystem');
    expect(host.querySelectorAll('button')).toHaveLength(0);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

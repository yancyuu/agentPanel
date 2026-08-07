import { describe, expect, it } from 'vitest';

import {
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
} from '@renderer/store/slices/teamSlice';

import type { TeamViewSnapshot } from '@shared/types';

function makeSnapshot(overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: 'team-aa5s',
    config: {
      name: '产品经理',
      color: 'blue',
      agentType: 'claudecode',
      projectPath: '/Users/demo/work',
      members: [],
    },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'team-aa5s', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

function stateWith(snapshot: TeamViewSnapshot) {
  return {
    teamDataCacheByName: { [snapshot.teamName]: snapshot },
    selectedTeamName: null,
    selectedTeamData: null,
    memberActivityMetaByTeam: {},
  } as never;
}

describe('v2 团队（团队即 agent）成员合成', () => {
  it('members 为空时合成团队自身为唯一成员（name=displayName）', () => {
    const snapshot = makeSnapshot();
    const members = selectResolvedMembersForTeamName(stateWith(snapshot), 'team-aa5s');

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      name: '产品经理',
      agentType: 'claudecode',
      role: 'lead',
      color: 'blue',
    });

    // owner=displayName 的任务能匹配到成员（分配语境显示已分配）
    expect(
      selectResolvedMemberForTeamName(stateWith(snapshot), 'team-aa5s', '产品经理')
    ).toMatchObject({ name: '产品经理' });
  });

  it('v1 多成员团队不受影响', () => {
    const snapshot = makeSnapshot({
      members: [
        { name: 'alice', currentTaskId: null, taskCount: 1 },
        { name: 'bob', currentTaskId: null, taskCount: 0 },
      ],
    });
    const members = selectResolvedMembersForTeamName(stateWith(snapshot), 'team-aa5s');

    expect(members.map((member) => member.name)).toEqual(['alice', 'bob']);
    expect(selectResolvedMemberForTeamName(stateWith(snapshot), 'team-aa5s', 'alice')).toMatchObject(
      { name: 'alice' }
    );
    // 未列在 members 里的名字不兜底
    expect(
      selectResolvedMemberForTeamName(stateWith(snapshot), 'team-aa5s', '产品经理')
    ).toBeNull();
  });

  it('displayName 缺省时回退到 teamName', () => {
    const snapshot = makeSnapshot({
      config: { name: '', projectPath: '/x', members: [] },
    });
    const members = selectResolvedMembersForTeamName(stateWith(snapshot), 'team-aa5s');
    expect(members[0]?.name).toBe('team-aa5s');
  });
});

import { describe, expect, it } from 'vitest';

import { projectOffice } from '../projectOffice';

import type { GraphDataPort, GraphNode } from '@claude-teams/agent-graph';
import type { ImLiveWorker } from '@shared/types/imLiveWorker';

const TEAM = 'hermit开发';

function member(
  id: string,
  overrides: Partial<GraphNode> & { currentTaskId?: string | null } = {}
): GraphNode {
  return {
    id,
    kind: 'member',
    label: id,
    state: 'idle',
    domainRef: { kind: 'member', teamName: TEAM, memberName: id },
    color: '#abc',
    ...overrides,
  };
}

function task(id: string, taskId: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'task',
    label: `#${id}`,
    state: 'active',
    taskStatus: 'in_progress',
    sublabel: `${id}-subject`,
    domainRef: { kind: 'task', teamName: TEAM, taskId },
    ...overrides,
  };
}

function graph(nodes: GraphNode[], teamName = TEAM): GraphDataPort {
  return { nodes, edges: [], particles: [], teamName };
}

function imWorker(overrides: Partial<ImLiveWorker> = {}): ImLiveWorker {
  return {
    key: 'feishu:oc_C:ou_S',
    provider: 'feishu',
    chatName: '产品群',
    project: 'hermit开发',
    agentSessionId: 'claude-im-1',
    state: 'busy',
    lastRole: 'assistant',
    lastActivityAt: '2026-06-21T13:00:00+08:00',
    lastUserSnippet: '帮我跑测试',
    ...overrides,
  };
}

describe('projectOffice — desks', () => {
  it('turns non-deleted task nodes into desks and marks completed ones', () => {
    const scene = projectOffice(
      graph([task('task:A', 'aid'), task('task:B', 'bid', { taskStatus: 'completed' })])
    );
    expect(scene.desks).toHaveLength(2);
    const done = scene.desks.find((d) => d.taskId === 'bid')!;
    expect(done.status).toBe('completed');
    expect(done.completed).toBe(true);
    expect(done.subject).toBe('task:B-subject');
    const active = scene.desks.find((d) => d.taskId === 'aid')!;
    expect(active.status).toBe('in_progress');
    expect(active.completed).toBe(false);
  });

  it('excludes deleted and overflow-stack tasks from desks', () => {
    const scene = projectOffice(
      graph([
        task('task:A', 'aid'),
        task('task:DEL', 'did', { taskStatus: 'deleted' }),
        task('task:OVF', 'oid', { isOverflowStack: true, overflowCount: 3 }),
      ])
    );
    expect(scene.desks.map((d) => d.taskId)).toEqual(['aid']);
  });
});

describe('projectOffice — team workers', () => {
  it('sits a member at the desk of its current task; members without a task go to the breakroom', () => {
    const scene = projectOffice(
      graph([
        member('alice', { currentTaskId: 'aid' }),
        member('bob'), // no current task
        task('task:A', 'aid'),
      ])
    );
    const alice = scene.teamWorkers.find((w) => w.memberName === 'alice')!;
    const bob = scene.teamWorkers.find((w) => w.memberName === 'bob')!;
    expect(alice.deskTaskNodeId).toBe('task:A');
    expect(bob.deskTaskNodeId).toBeUndefined();
  });

  it('includes the lead as a breakroom worker', () => {
    const lead: GraphNode = {
      id: 'lead:x',
      kind: 'lead',
      label: 'lead',
      state: 'active',
      domainRef: { kind: 'lead', teamName: TEAM, memberName: 'user' },
    };
    const scene = projectOffice(graph([lead]));
    expect(scene.teamWorkers).toHaveLength(1);
    expect(scene.teamWorkers[0].isLead).toBe(true);
    expect(scene.teamWorkers[0].deskTaskNodeId).toBeUndefined();
  });

  it.each([
    ['tool_calling', 'typing'],
    ['thinking', 'thinking'],
    ['active', 'typing'],
    ['terminated', 'terminated'],
    ['idle', 'idle'],
  ] as const)('maps member state %s -> anim %s', (state, anim) => {
    const scene = projectOffice(graph([member('m', { state })]));
    expect(scene.teamWorkers[0].animState).toBe(anim);
  });

  it('maps error state and exception tone to error', () => {
    const a = projectOffice(graph([member('a', { state: 'error' })]));
    expect(a.teamWorkers[0].animState).toBe('error');
    const b = projectOffice(graph([member('b', { state: 'active', exceptionTone: 'error' })]));
    expect(b.teamWorkers[0].animState).toBe('error');
  });

  it('maps pending approval to waiting', () => {
    const scene = projectOffice(graph([member('m', { state: 'active', pendingApproval: true })]));
    expect(scene.teamWorkers[0].animState).toBe('waiting');
    expect(scene.teamWorkers[0].pendingApproval).toBe(true);
  });

  it('treats a member with a running activeTool as typing even when state is idle', () => {
    const scene = projectOffice(
      graph([
        member('m', {
          state: 'idle',
          activeTool: { name: 'Bash', state: 'running', startedAt: 't', source: 'runtime' },
        }),
      ])
    );
    expect(scene.teamWorkers[0].animState).toBe('typing');
  });

  it('builds the bubble label from activeTool.name, then currentTaskSubject, then exceptionLabel', () => {
    const withTool = projectOffice(
      graph([
        member('m', {
          state: 'active',
          currentTaskSubject: 'write tests',
          activeTool: { name: 'Edit', state: 'running', startedAt: 't', source: 'runtime' },
        }),
      ])
    );
    expect(withTool.teamWorkers[0].bubbleLabel).toBe('Edit');

    const withSubject = projectOffice(
      graph([member('m', { state: 'active', currentTaskSubject: 'write tests' })])
    );
    expect(withSubject.teamWorkers[0].bubbleLabel).toBe('write tests');

    const withExc = projectOffice(
      graph([member('m', { state: 'active', exceptionLabel: 'spawn failed' })])
    );
    expect(withExc.teamWorkers[0].bubbleLabel).toBe('spawn failed');
  });
});

describe('projectOffice — IM workers', () => {
  it('maps IM live workers to the front-desk zone with the inbound snippet as bubble', () => {
    const scene = projectOffice(graph([]), [imWorker()]);
    expect(scene.imWorkers).toHaveLength(1);
    expect(scene.imWorkers[0]).toMatchObject({
      project: 'hermit开发',
      chatName: '产品群',
      state: 'busy',
      bubbleLabel: '帮我跑测试',
      agentSessionId: 'claude-im-1',
    });
  });

  it('does not crash and returns empty zones for an empty graph', () => {
    const scene = projectOffice(graph([]), []);
    expect(scene.teamWorkers).toEqual([]);
    expect(scene.desks).toEqual([]);
    expect(scene.imWorkers).toEqual([]);
    expect(scene.teamName).toBe(TEAM);
  });
});

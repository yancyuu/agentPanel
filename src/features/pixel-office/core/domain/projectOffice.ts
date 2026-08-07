/**
 * Pure projection: agent-graph data + IM live workers → an office scene.
 *
 * The pixel office renders two zones from this scene: team agents sitting at
 * their task desks (or in the breakroom), and IM conversations at the front
 * desk. This module owns the ONLY mapping from graph node state to office
 * animation state, so the rules have one place to change. It consumes the same
 * {@link GraphDataPort} the agent-graph view already builds (via
 * useTeamGraphAdapter) — it does not re-subscribe to any store.
 */

import type { GraphDataPort, GraphNode } from '@claude-teams/agent-graph';
import type { ImLiveWorker, ImWorkerState } from '@shared/types/imLiveWorker';

export type WorkerAnimState = 'typing' | 'thinking' | 'waiting' | 'idle' | 'error' | 'terminated';

export interface TeamOfficeWorker {
  nodeId: string;
  memberName: string;
  isLead: boolean;
  color?: string;
  avatarUrl?: string;
  animState: WorkerAnimState;
  /** Task desk node id the worker sits at; undefined → breakroom. */
  deskTaskNodeId?: string;
  bubbleLabel?: string;
  pendingApproval?: boolean;
  teamName: string;
}

export interface OfficeDesk {
  taskNodeId: string;
  taskId: string;
  subject: string;
  displayId?: string;
  status: 'pending' | 'in_progress' | 'completed';
  completed: boolean;
  ownerId?: string;
}

export interface ImOfficeWorker {
  key: string;
  project: string;
  chatName?: string;
  senderName?: string;
  state: ImWorkerState;
  bubbleLabel?: string;
  agentSessionId: string;
}

export interface OfficeScene {
  teamName: string;
  teamWorkers: TeamOfficeWorker[];
  desks: OfficeDesk[];
  imWorkers: ImOfficeWorker[];
}

function isRenderableTask(node: GraphNode): boolean {
  return node.kind === 'task' && !node.isOverflowStack && node.taskStatus !== 'deleted';
}

function mapAnimState(node: GraphNode): WorkerAnimState {
  if (node.state === 'error' || node.exceptionTone === 'error') return 'error';
  if (node.pendingApproval) return 'waiting';
  if (node.activeTool?.state === 'running') return 'typing';
  switch (node.state) {
    case 'tool_calling':
    case 'active':
      return 'typing';
    case 'thinking':
      return 'thinking';
    case 'waiting':
      return 'waiting';
    case 'terminated':
      return 'terminated';
    case 'complete':
    case 'idle':
    default:
      return 'idle';
  }
}

function bubbleLabelFor(node: GraphNode): string | undefined {
  if (node.activeTool?.state === 'running') return node.activeTool.name;
  return node.currentTaskSubject ?? node.exceptionLabel ?? undefined;
}

export function projectOffice(
  graphData: GraphDataPort,
  imWorkers: ImLiveWorker[] = []
): OfficeScene {
  const { nodes, teamName } = graphData;

  const taskNodeIdByTaskId = new Map<string, string>();
  for (const node of nodes) {
    if (isRenderableTask(node) && node.domainRef.kind === 'task') {
      taskNodeIdByTaskId.set(node.domainRef.taskId, node.id);
    }
  }

  const desks: OfficeDesk[] = nodes.filter(isRenderableTask).map((node) => {
    const status = (node.taskStatus ?? 'pending') as OfficeDesk['status'];
    const taskId = node.domainRef.kind === 'task' ? node.domainRef.taskId : node.id;
    return {
      taskNodeId: node.id,
      taskId,
      subject: node.sublabel ?? node.label,
      displayId: node.displayId,
      status,
      completed: status === 'completed',
      ownerId: node.ownerId ?? undefined,
    };
  });

  const teamWorkers: TeamOfficeWorker[] = nodes
    .filter((node) => node.kind === 'member' || node.kind === 'lead')
    .map((node) => {
      const isLead = node.kind === 'lead';
      const memberName =
        node.domainRef.kind === 'member' || node.domainRef.kind === 'lead'
          ? node.domainRef.memberName
          : node.label;
      let deskTaskNodeId: string | undefined;
      if (!isLead && node.currentTaskId) {
        deskTaskNodeId = taskNodeIdByTaskId.get(node.currentTaskId);
      }
      return {
        nodeId: node.id,
        memberName,
        isLead,
        color: node.color,
        avatarUrl: node.avatarUrl,
        animState: mapAnimState(node),
        deskTaskNodeId,
        bubbleLabel: bubbleLabelFor(node),
        pendingApproval: node.pendingApproval,
        teamName,
      };
    });

  const imOfficeWorkers: ImOfficeWorker[] = imWorkers.map((w) => ({
    key: w.key,
    project: w.project,
    chatName: w.chatName,
    senderName: w.senderName,
    state: w.state,
    bubbleLabel: w.lastUserSnippet,
    agentSessionId: w.agentSessionId,
  }));

  return { teamName, teamWorkers, desks, imWorkers: imOfficeWorkers };
}

/**
 * Worker（数字劳动力）抽象 — Spec 9 / FR-2
 *
 * 统一「Hermit 团队（composite worker）」与「外部单能力服务（atomic worker）」。
 * 关键约束：teamName 即 workerId，不引入新的身份字段。
 * 本文件为向后兼容的类型扩展，不改动任何现有持久化格式。
 */

import type { AgentCapability, DiscoverableTeam } from './team';

export type WorkerKind = 'composite' | 'atomic';

/** Worker 身份。composite → workerId = teamName；atomic → 服务自报 id。 */
export interface WorkerIdentity {
  workerId: string;
  name: string;
  kind: WorkerKind;
  /** 运行时载体：'claude' | 'codex' | 'micro-sniper' | ... */
  harness?: string;
}

/** 能力项 — 复用现有 AgentCapability 形状（{ skill, description }）。 */
export type WorkerCapability = AgentCapability;

/** 花名册中可被发现的 Worker。DiscoverableTeam 是其 composite 特例。 */
export interface DiscoverableWorker extends WorkerIdentity {
  location: 'local' | 'remote';
  status: 'online' | 'offline';
  capabilities?: WorkerCapability[];
  description?: string;
  /** Canonical project path, forwarded from the team manifest for /workers output. */
  workDir?: string;
}

/** atomic worker 的 dispatch 立即响应（fire-and-forget，不阻塞长任务）。 */
export interface WorkerDispatchAck {
  taskId: string;
  status: 'received';
}

/** atomic worker 任务状态查询结果。 */
export interface WorkerTaskState {
  taskId: string;
  status:
    | 'dispatched'
    | 'pending_accept'
    | 'accepted'
    | 'rejected'
    | 'received'
    | 'in_progress'
    | 'completed'
    | 'synced_back'
    | 'failed';
  result?: unknown;
  error?: string;
}

/**
 * 把现有 DiscoverableTeam 适配为 DiscoverableWorker（composite）。
 * teamName(slug) 即 workerId，零字段新增。
 */
export function discoverableTeamToWorker(team: DiscoverableTeam): DiscoverableWorker {
  return {
    workerId: team.slug,
    name: team.displayName,
    kind: 'composite',
    harness: team.harness,
    location: team.location,
    status: team.status,
    capabilities: team.capabilities,
    description: team.description,
    workDir: team.workDir,
  };
}

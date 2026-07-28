/**
 * RuntimeReadinessService — central source of truth for "is the runtime
 * (cc-connect) ready to serve" status, exposed to the UI so a degraded boot
 * (cc-connect binary missing / bridge offline) shows a clear banner with a
 * fix path instead of surfacing later as a cryptic "fetch failed".
 *
 * Lifecycle:
 *   - server boot tracks a non-blocking ensureBinaryReady() diagnostic and
 *     calls markBridgeBinaryCheck() with its eventual result (ok | degraded + reason).
 *   - the sidecar auto-launch (.then/.catch in server.ts) calls
 *     markBridgeLaunch() to record whether the sidecar actually came up.
 *   - GET /api/v1/system/readiness returns the merged view for the UI.
 *
 * Why a dedicated service (not just inline vars): the boot path, the
 * fire-and-forget launcher, and the HTTP handler all need to read/write this
 * state without race-prone scattered globals. Keeping it here also makes the
 * "degraded" semantics testable in isolation.
 */

import { createLogger } from '@shared/utils/logger';

import type {
  BridgeBinaryState,
  BridgeLaunchState,
  RuntimeReadiness,
} from '@shared/types/runtimeReadiness';

// Re-export the shared shapes so callers import them from the service.
export type {
  BridgeBinaryState,
  BridgeLaunchState,
  RuntimeReadiness,
} from '@shared/types/runtimeReadiness';

const log = createLogger('RuntimeReadiness');

const DEFAULT_REMEDIATION = [
  '在终端运行: npm install -g cc-connect',
  '或设置环境变量 CC_CONNECT_MIRROR 指向可用的 GitHub release 代理（如 https://gh-proxy.com/）',
  '安装完成后重启 AgentCli 工作台',
];

let bridgeBinary: BridgeBinaryState = {
  status: 'degraded',
  reason: '尚未检查',
  remediation: DEFAULT_REMEDIATION,
};
let bridgeLaunch: BridgeLaunchState = { status: 'starting' };
let updatedAt = new Date().toISOString();

function touch(): void {
  updatedAt = new Date().toISOString();
}

export function markBridgeBinaryCheck(state: BridgeBinaryState): void {
  bridgeBinary = state;
  touch();
  if (state.status === 'ok') {
    log.info({ cmd: state.cmd }, 'cc-connect binary ready');
  } else {
    log.warn({ reason: state.reason }, 'cc-connect binary not ready (degraded)');
  }
}

export function markBridgeLaunch(state: BridgeLaunchState): void {
  bridgeLaunch = state;
  touch();
  log.info({ state }, 'cc-connect launch state updated');
}

export function getRuntimeReadiness(): RuntimeReadiness {
  const status: RuntimeReadiness['status'] =
    bridgeBinary.status === 'ok' && bridgeLaunch.status === 'running' ? 'ok' : 'degraded';
  return { status, bridgeBinary, bridgeLaunch, updatedAt };
}

/** Test-only: reset state between unit tests. */
export function __resetRuntimeReadiness(): void {
  bridgeBinary = { status: 'degraded', reason: '尚未检查', remediation: DEFAULT_REMEDIATION };
  bridgeLaunch = { status: 'starting' };
  touch();
}

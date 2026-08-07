/**
 * RuntimeReadiness — shared shape for the "is cc-connect ready" status returned
 * by GET /api/v1/system/readiness and consumed by the UI degraded banner.
 *
 * Mirrors the backend service in src/main/services/system/RuntimeReadiness.ts.
 * Kept in shared/types so the Fastify handler, the renderer api client, and the
 * banner component all read exactly the same fields.
 */

export type BridgeBinaryState =
  | { status: 'ok'; cmd: string }
  | { status: 'degraded'; reason: string; remediation: string[] }
  | { status: 'disabled' };

export type BridgeLaunchState =
  | { status: 'running'; pid?: number }
  | { status: 'starting' }
  | { status: 'offline'; reason: string }
  | { status: 'disabled' };

export interface RuntimeReadiness {
  /** Overall health rollup the UI can key off. */
  status: 'ok' | 'degraded' | 'disabled';
  /** cc-connect binary is present and launchable (self-healed if needed). */
  bridgeBinary: BridgeBinaryState;
  /** cc-connect sidecar process state (may lag binary readiness). */
  bridgeLaunch: BridgeLaunchState;
  /** ISO timestamp of the last state change, for UI staleness checks. */
  updatedAt: string;
}

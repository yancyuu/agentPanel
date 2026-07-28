import { SYSTEM_MANAGER_BIND_PROJECT, SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';

import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

export const CC_AGENT_TYPES: readonly HermitBridgeAgentType[] = [
  'claudecode',
  'codex',
  'cursor',
  'gemini',
  'iflow',
  'kimi',
  'devin',
  'opencode',
  'qoder',
  'pi',
  'acp',
  'tmux',
];

export function toHermitBridgeAgentType(value: string | undefined): HermitBridgeAgentType {
  return CC_AGENT_TYPES.includes(value as HermitBridgeAgentType)
    ? (value as HermitBridgeAgentType)
    : 'claudecode';
}

export function isReservedSystemTeamName(teamName: string): boolean {
  return (
    teamName === 'default' ||
    teamName === SYSTEM_MANAGER_BIND_PROJECT ||
    teamName === SYSTEM_MANAGER_TEAM_NAME
  );
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

export function normalizePlatformAllowFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(
      ([platform, allowFrom]) =>
        [platform.trim(), typeof allowFrom === 'string' ? allowFrom.trim() : ''] as const
    )
    .filter(([platform, allowFrom]) => platform.length > 0 && allowFrom.length > 0);
  return Object.fromEntries(entries);
}

function hasPlatformAllowDeleteMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([platform, allowFrom]) =>
      platform.trim().length > 0 && (typeof allowFrom !== 'string' || allowFrom.trim().length === 0)
  );
}

export function normalizePlatformAllowUpdate(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = normalizePlatformAllowFrom(value);
  if (Object.keys(normalized).length > 0) {
    if ('lark' in normalized) delete normalized.feishu;
    return normalized;
  }
  return Object.keys(value).length === 0 || hasPlatformAllowDeleteMarker(value) ? {} : undefined;
}

export function isCcProjectNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /project not found:/i.test(message);
}

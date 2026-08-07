import {
  isExternalPlatformSessionKey as isParsedExternalPlatformSessionKey,
  parseExternalPlatformSessionKey as parsePlatformSessionKey,
} from '@main/utils/externalPlatformSessionKey';

import type { TeamManifest } from '@main/services/team-management/TeamWorkspaceService';

const FEISHU_LARK_KEYS = new Set(['feishu', 'lark']);

function routingUserIdFromSessionKey(
  sessionKey: string,
  platform: string,
  parsedUserId: string | undefined
): string | undefined {
  if (parsedUserId || !FEISHU_LARK_KEYS.has(platform)) return parsedUserId;
  const [, ...ids] = sessionKey.split(':').filter(Boolean);
  return ids.find((id) => /^ou_/i.test(id));
}

export interface ExternalPlatformSessionKey {
  platform: string;
  chatId?: string;
  userId?: string;
}

export function isExternalPlatformSessionKey(sessionKey: string): boolean {
  return isParsedExternalPlatformSessionKey(sessionKey);
}

export function parseExternalPlatformSessionKey(
  sessionKey: string
): ExternalPlatformSessionKey | null {
  const parsed = parsePlatformSessionKey(sessionKey);
  if (parsed.kind !== 'external-platform' || !parsed.platform) return null;
  return {
    platform: parsed.platform,
    chatId: parsed.chatId,
    userId: parsed.userId,
  };
}

function getPlatformAllowValue(
  record: Record<string, string> | undefined,
  platform: string
): string {
  if (!record) return '';
  if (FEISHU_LARK_KEYS.has(platform)) {
    return record[platform] ?? record[platform === 'feishu' ? 'lark' : 'feishu'] ?? '';
  }
  return record[platform] ?? '';
}

function normalizeFeishuLarkChatId(value: string): string {
  return value.replace(/^oc_/i, 'c_');
}

function normalizeAllowValue(platform: string, value: string): string {
  return FEISHU_LARK_KEYS.has(platform) ? normalizeFeishuLarkChatId(value) : value;
}

function matchesAllowList(allowList: string, value: string | undefined, platform: string): boolean {
  const trimmed = allowList.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  if (!value) return false;
  const normalizedValue = normalizeAllowValue(platform, value);
  return trimmed
    .split(/[\s,]+/)
    .map((entry) => normalizeAllowValue(platform, entry.trim()))
    .filter(Boolean)
    .includes(normalizedValue);
}

function scoreManifestForSession(
  manifest: TeamManifest,
  parsed: ExternalPlatformSessionKey
): number {
  const allowChat = getPlatformAllowValue(manifest.platformAllowChat, parsed.platform);
  const allowFrom = getPlatformAllowValue(manifest.platformAllowFrom, parsed.platform);
  let score = 0;

  if (allowChat) {
    if (!matchesAllowList(allowChat, parsed.chatId, parsed.platform)) return 0;
    score += allowChat.trim() === '*' ? 1 : 4;
  }

  if (allowFrom) {
    if (!matchesAllowList(allowFrom, parsed.userId, parsed.platform)) return 0;
    score += allowFrom.trim() === '*' ? 1 : 3;
  }

  return score;
}

/**
 * Resolves an external platform session key (for example `feishu:{chat}:{user}`)
 * to a Hermit-managed team slug using local allow-list metadata. Returns null
 * when no team matches or when multiple teams are equally plausible.
 */
export function resolveExternalPlatformSessionTeamSlug(
  sessionKey: string,
  manifests: readonly TeamManifest[]
): string | null {
  const parsed = parseExternalPlatformSessionKey(sessionKey);
  if (!parsed) return null;
  const routableParsed = {
    ...parsed,
    userId: routingUserIdFromSessionKey(sessionKey, parsed.platform, parsed.userId),
  };

  const ranked = manifests
    .map((manifest) => ({ manifest, score: scoreManifestForSession(manifest, routableParsed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].manifest.slug || ranked[0].manifest.bindProject;
}

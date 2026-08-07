export interface ExternalPlatformSessionKeyParts {
  platform?: string;
  chatId?: string;
  userId?: string;
  kind: 'external-platform' | 'hermit-local' | 'unknown';
}

// Mirrors cc-connect's built-in IM platform set. When cc-connect gains a new
// platform, add it here so its turns are tracked (producer emits for every
// turn already; this is the consumer-side allowlist). Long-term this list
// should be sourced from cc-connect at startup rather than hardcoded.
const EXTERNAL_PLATFORM_RE =
  /^(feishu|lark|weixin|wechat|dingtalk|qq|telegram|discord|slack|line)$/i;

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isExternalPlatformName(value: string | undefined): boolean {
  return Boolean(value && EXTERNAL_PLATFORM_RE.test(value));
}

export function isFeishuLikePlatform(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === 'feishu' || normalized === 'lark';
}

export function isFeishuUnionUserId(value: string | undefined): boolean {
  return Boolean(value && (/^on_/i.test(value) || /^union/i.test(value)));
}

export function stableExternalPlatformUserId(
  platform: string | undefined,
  userId: string | undefined
): string | undefined {
  const normalized = normalizeOptionalString(userId);
  if (!normalized) return undefined;
  if (isFeishuLikePlatform(platform))
    return isFeishuUnionUserId(normalized) ? normalized : undefined;
  return normalized;
}

function userIdFromSessionIds(platform: string | undefined, ids: string[]): string | undefined {
  if (isFeishuLikePlatform(platform)) {
    return ids.find((id) => isFeishuUnionUserId(id));
  }
  return (
    ids.find((id) => /^(ou|on|union|user|u)_/i.test(id)) ?? (ids.length >= 2 ? ids[1] : undefined)
  );
}

export function parseExternalPlatformSessionKey(
  sessionKey: string
): ExternalPlatformSessionKeyParts {
  const [rawPlatform, ...ids] = sessionKey.split(':').filter(Boolean);
  const platform = normalizeOptionalString(rawPlatform)?.toLowerCase();
  if (platform === 'hermit') {
    return { platform, kind: 'hermit-local' };
  }

  const chatId =
    ids.find((id) => /^(oc|chat|group|room|c)_/i.test(id)) ??
    (ids.length >= 2 ? ids[0] : undefined);
  const userId = userIdFromSessionIds(platform, ids);

  return {
    platform,
    chatId,
    userId,
    kind: isExternalPlatformName(platform) ? 'external-platform' : 'unknown',
  };
}

export function isExternalPlatformSessionKey(sessionKey: string): boolean {
  return parseExternalPlatformSessionKey(sessionKey).kind === 'external-platform';
}

export function looksLikeChannelId(value: string | undefined): boolean {
  return !!value && /^[A-Za-z]+_[A-Za-z0-9_-]+$/.test(value);
}

export function shortIdentityId(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function formatIdentityFallback(
  platform: string | undefined,
  type: 'conversation' | 'group' | 'person',
  id: string
): string {
  const prefix = platform ? `${platform} ` : '';
  const label = type === 'group' ? '未解析群聊' : type === 'person' ? '未解析用户' : '未解析会话';
  return `${prefix}${label} ${shortIdentityId(id)}`;
}

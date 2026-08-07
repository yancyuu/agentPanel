const FEISHU_LARK_KEYS = new Set(['feishu', 'lark']);
const PLATFORM_ALLOW_ALIASES: Record<string, readonly string[]> = {
  feishu: ['lark'],
  lark: ['feishu'],
  weixin: ['wechat'],
  wechat: ['weixin'],
  wecom_ws: ['wecom'],
  wecom: ['wecom_ws'],
};

export function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key.trim(), typeof entry === 'string' ? entry.trim() : ''] as const)
      .filter(([key, entry]) => key.length > 0 && entry.length > 0)
  );
}

function getPlatformAllowKeys(platform: string): string[] {
  return [platform, ...(PLATFORM_ALLOW_ALIASES[platform] ?? [])];
}

function hasAnyPlatformAllowKey(record: Record<string, string>, platform: string): boolean {
  return getPlatformAllowKeys(platform).some((key) => record[key] !== undefined);
}

export function getPlatformAllowValue(record: Record<string, string>, platform: string): string {
  const source = readStringRecord(record);
  for (const key of getPlatformAllowKeys(platform)) {
    if (source[key] !== undefined) return source[key];
  }
  return '';
}

export function withPlatformAllowValue(
  base: Record<string, string>,
  platform: string,
  value: string
): Record<string, string> {
  const source = readStringRecord(base);
  const next = { ...source };
  const trimmed = value.trim();
  const keys = getPlatformAllowKeys(platform);
  const writeKey = keys.find((key) => source[key] !== undefined) ?? platform;

  for (const key of keys) {
    delete next[key];
  }

  if (trimmed) {
    next[writeKey] = trimmed;
  }

  return next;
}

export function getFeishuLarkAllowValue(record: Record<string, string>): string {
  return getPlatformAllowValue(record, 'lark');
}

function hasFeishuLarkKey(record: Record<string, string>): boolean {
  return hasAnyPlatformAllowKey(record, 'feishu');
}

export function withFeishuLarkAllowValue(
  base: Record<string, string>,
  value: string
): Record<string, string> {
  return withPlatformAllowValue(base, 'lark', value);
}

export function buildFeishuLarkAllowUpdatePayload(
  base: Record<string, string>,
  value: string
): Record<string, string> | undefined {
  const source = readStringRecord(base);
  const next = withFeishuLarkAllowValue(source, value);
  const trimmed = value.trim();

  if (trimmed) return next;

  if (hasFeishuLarkKey(source)) {
    return {
      ...next,
      feishu: '',
      lark: '',
    };
  }

  return undefined;
}

export function buildPlatformAllowUpdatePayload(
  base: Record<string, string>,
  values: Record<string, string>
): Record<string, string> | undefined {
  const source = readStringRecord(base);
  const next = readStringRecord(values);

  const keys = new Set([...Object.keys(source), ...Object.keys(values)]);
  const changed = [...keys].some((key) => (source[key] ?? '') !== (next[key] ?? ''));

  return changed ? next : undefined;
}

export function omitEmptyAllowMap(
  record: Record<string, string>
): Record<string, string> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}

export function hasFeishuLarkDeleteMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      FEISHU_LARK_KEYS.has(key.trim()) && (typeof entry !== 'string' || entry.trim().length === 0)
  );
}

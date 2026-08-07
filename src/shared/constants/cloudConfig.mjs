// cloudConfig.mjs — SINGLE SOURCE for the AgentBus / AI-Monitor endpoint.
//
// CLI, telemetry worker, conversation upload, auth and Lark reporting all read
// this complete URL. Repointing the product requires changing this value only.
// Environment variables and explicit custom ~/.hermit settings still override it.

export const DEFAULT_OPENHERMIT_CLOUD_BASE_URL = 'https://agentbus.skg.com';

const LEGACY_OPENHERMIT_CLOUD_BASE_URLS = new Set([
  // Legacy defaults must stay http verbatim — they match values persisted in
  // existing user settings; rewriting them here would break the migration check.
  // eslint-disable-next-line sonarjs/no-clear-text-protocols
  'http://47.112.24.153',
  // eslint-disable-next-line sonarjs/no-clear-text-protocols
  'http://159.75.231.98:8088',
]);

/**
 * Product-owned historical defaults migrate automatically on upgrade. Explicit
 * custom domains are never rewritten.
 */
export function migrateLegacyCloudBaseUrl(value) {
  // eslint-disable-next-line sonarjs/slow-regex -- anchored trailing-slash trim is linear
  const normalized = String(value || '').trim().replace(/\/+$/u, '');
  if (!normalized) return normalized;
  return LEGACY_OPENHERMIT_CLOUD_BASE_URLS.has(normalized)
    ? DEFAULT_OPENHERMIT_CLOUD_BASE_URL
    : normalized;
}

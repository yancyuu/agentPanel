import { describe, expect, it } from 'vitest';

import {
  formatProviderBackendLabel,
  getDefaultProviderBackendId,
  isLegacyCodexProviderBackendId,
  isTeamProviderBackendId,
  migrateProviderBackendId,
} from '../providerBackend';

describe('getDefaultProviderBackendId', () => {
  it('returns codex-native for Codex', () => {
    expect(getDefaultProviderBackendId('codex')).toBe('codex-native');
  });

  it('returns undefined for non-Codex providers', () => {
    expect(getDefaultProviderBackendId('anthropic')).toBeUndefined();
    expect(getDefaultProviderBackendId('gemini')).toBeUndefined();
    expect(getDefaultProviderBackendId('opencode')).toBeUndefined();
    expect(getDefaultProviderBackendId(undefined)).toBeUndefined();
  });
});

describe('isLegacyCodexProviderBackendId', () => {
  it.each(['auto', 'adapter', 'api'])('identifies %s as legacy', (id) => {
    expect(isLegacyCodexProviderBackendId(id)).toBe(true);
  });

  it.each(['codex-native', 'cli-sdk', undefined, null, '', 'unknown'])(
    'does not identify %s as legacy',
    (id) => {
      expect(isLegacyCodexProviderBackendId(id)).toBe(false);
    }
  );
});

describe('isTeamProviderBackendId', () => {
  it.each(['auto', 'adapter', 'api', 'cli-sdk', 'codex-native'])(
    'accepts valid backend id %s',
    (id) => {
      expect(isTeamProviderBackendId(id)).toBe(true);
    }
  );

  it.each(['', 'native', 'sdk', null, undefined])('rejects invalid %s', (id) => {
    expect(isTeamProviderBackendId(id)).toBe(false);
  });
});

describe('migrateProviderBackendId', () => {
  it('forces codex-native for Codex when backend is missing or legacy', () => {
    expect(migrateProviderBackendId('codex', null)).toBe('codex-native');
    expect(migrateProviderBackendId('codex', undefined)).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'auto')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'adapter')).toBe('codex-native');
  });

  it('keeps a valid non-legacy Codex backend', () => {
    expect(migrateProviderBackendId('codex', 'cli-sdk')).toBe('cli-sdk');
  });

  it('passes through valid backends for non-Codex providers', () => {
    expect(migrateProviderBackendId('gemini', 'cli-sdk')).toBe('cli-sdk');
    expect(migrateProviderBackendId('anthropic', 'auto')).toBe('auto');
  });

  it('returns undefined for invalid backends on non-Codex providers', () => {
    expect(migrateProviderBackendId('gemini', 'totally-bogus')).toBeUndefined();
  });
});

describe('formatProviderBackendLabel', () => {
  it('labels codex-native as "Codex native"', () => {
    expect(formatProviderBackendLabel('codex', 'codex-native')).toBe('Codex native');
  });

  it('labels gemini cli-sdk as "CLI SDK"', () => {
    expect(formatProviderBackendLabel('gemini', 'cli-sdk')).toBe('CLI SDK');
  });

  it('returns undefined for gemini auto backend', () => {
    expect(formatProviderBackendLabel('gemini', 'auto')).toBeUndefined();
  });

  it('returns undefined when no backend resolves', () => {
    expect(formatProviderBackendLabel('anthropic', undefined)).toBeUndefined();
  });
});

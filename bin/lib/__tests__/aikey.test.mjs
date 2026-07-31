// Tests for bin/lib/aikey.mjs — the CLI's "认领 aikey" command + config writer.
//
// Covers the provider→SDK-env-var map, the ~/.hermit/aikey.env marker file, and
// the applyToConfigs surgical writes into Claude / Codex config. The legacy
// precmd/PROMPT_COMMAND shell hook is gone (config-file injection replaced it),
// so it has no tests here.
//
// Adaptations to hermit's reality (no local aikey-proxy; server endpoint with a
// local mock fallback):
//   1. file path is hermit-scoped (~/.hermit/aikey.env) instead of ~/.aikey/active.env,
//   2. the written value is the REAL key (aikey's own `--direct` mode does this when
//      there is no proxy), not a proxy sentinel token,
//   3. *_BASE_URL is written only when a base url is actually provided.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalProvider,
  parseActiveEnv,
  providerEnvVars,
  readMockBundle,
  renderActiveEnv,
  resolveApiKeyBundle,
} from '../aikey.mjs';

describe('aikey provider mapping (ported from aikey provider_env_vars)', () => {
  it('canonicalProvider resolves brand aliases to canonical codes', () => {
    expect(canonicalProvider('anthropic')).toBe('anthropic');
    expect(canonicalProvider('Claude')).toBe('anthropic');
    expect(canonicalProvider('openai')).toBe('openai');
    expect(canonicalProvider('gpt')).toBe('openai');
    expect(canonicalProvider('chatgpt')).toBe('openai');
    expect(canonicalProvider('gemini')).toBe('google');
    expect(canonicalProvider('google')).toBe('google');
    expect(canonicalProvider('kimi')).toBe('kimi');
    expect(canonicalProvider('deepseek')).toBe('deepseek');
    expect(canonicalProvider('moonshot')).toBe('moonshot');
    expect(canonicalProvider('unknown')).toBeNull();
    expect(canonicalProvider('')).toBeNull();
  });

  it('providerEnvVars returns [apiKeyVar, baseUrlVar] for known providers and null otherwise', () => {
    expect(providerEnvVars('anthropic')).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    expect(providerEnvVars('claude')).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    expect(providerEnvVars('openai')).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
    expect(providerEnvVars('kimi')).toEqual(['KIMI_API_KEY', 'KIMI_BASE_URL']);
    expect(providerEnvVars('nope')).toBeNull();
  });
});

describe('aikey renderActiveEnv (ported from write_active_env; REAL key, no proxy)', () => {
  it('writes the real key + base url for each provider, skipping base url when absent', () => {
    const bundle = {
      displayName: 'work-key',
      providers: {
        anthropic: { apiKey: 'sk-ant-real', baseUrl: 'https://api.anthropic.com' },
        openai: { apiKey: 'sk-real' },
      },
    };
    const content = renderActiveEnv(bundle);

    // Header comment first (aikey writes "auto-generated … do not edit manually").
    expect(content.split('\n')[0]).toMatch(/auto-generated.*do not edit/i);

    // Real key IS written (hermit has no proxy → no sentinel).
    expect(content).toContain('export ANTHROPIC_API_KEY="sk-ant-real"');
    expect(content).toContain('export ANTHROPIC_BASE_URL="https://api.anthropic.com"');
    expect(content).toContain('export OPENAI_API_KEY="sk-real"');

    // openai has no base url → no OPENAI_BASE_URL line.
    expect(content).not.toContain('OPENAI_BASE_URL');

    // Active-key label is exported so the shell can show which key is live.
    expect(content).toContain('export OPENHERMIT_ACTIVE_KEY="work-key"');
  });

  it('shell-quotes remote values without executing command substitutions', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aikey-shell-quote-'));
    const marker = path.join(home, 'executed');
    const key = `sk-live-$(touch ${marker})-\`touch ${marker}\`-"-$-\\`;
    const envPath = path.join(home, 'aikey.env');
    try {
      await writeFile(
        envPath,
        renderActiveEnv({
          displayName: 'remote " key $()',
          providers: { openai: { apiKey: key, baseUrl: 'https://api.example.test/$()' } },
        })
      );
      const sourced = execFileSync(
        'sh',
        ['-c', '. "$1"; printf "%s" "$OPENAI_API_KEY"', 'sh', envPath],
        { encoding: 'utf8' }
      );
      expect(sourced).toBe(key);
      expect(existsSync(marker)).toBe(false);
      expect(parseActiveEnv(await readFile(envPath, 'utf8')).vars.OPENAI_API_KEY).toBe(key);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects multiline values instead of emitting executable shell lines', () => {
    expect(() =>
      renderActiveEnv({ providers: { openai: { apiKey: 'sk-safe\nmalicious' } } })
    ).toThrow('控制字符');
  });

  it('ignores providers that have no key value', () => {
    const content = renderActiveEnv({
      displayName: 'x',
      providers: { anthropic: { apiKey: '' }, openai: { apiKey: 'sk-real' } },
    });
    expect(content).not.toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('export OPENAI_API_KEY="sk-real"');
  });
});

describe('aikey parseActiveEnv (inverse of renderActiveEnv)', () => {
  it('parses exported vars and lifts OPENHERMIT_ACTIVE_KEY into label', () => {
    const content = [
      '# openhermit active key — auto-generated, do not edit manually',
      'export OPENHERMIT_ACTIVE_KEY="demo"',
      'export ANTHROPIC_API_KEY="sk-ant-real"',
      'export ANTHROPIC_BASE_URL="https://api.anthropic.com"',
      'export OPENAI_API_KEY="sk-real"',
    ].join('\n');
    const { label, vars } = parseActiveEnv(content);
    expect(label).toBe('demo');
    expect(vars.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(vars.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(vars.OPENAI_API_KEY).toBe('sk-real');
    // label is lifted out of vars, not duplicated.
    expect(vars.OPENHERMIT_ACTIVE_KEY).toBeUndefined();
  });

  it('ignores comments, blanks, and non-export lines', () => {
    const { label, vars } = parseActiveEnv('# comment\n\nset X=1\nexport FOO="bar"');
    expect(label).toBeNull();
    expect(vars).toEqual({ FOO: 'bar' });
  });

  it('returns empty for null / empty content', () => {
    expect(parseActiveEnv(null)).toEqual({ label: null, vars: {} });
    expect(parseActiveEnv('')).toEqual({ label: null, vars: {} });
  });
});

describe('aikey mock key source', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(); // placeholder, replaced below
  });
  afterEach(async () => {
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  });

  function mkdtempSync() {
    // sync wrapper so beforeEach is simple
    const dir = path.join(os.tmpdir(), `hermit-aikey-${Math.random().toString(36).slice(2)}`);
    return dir;
  }

  it('readMockBundle returns null when no mock file exists', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-'));
    expect(readMockBundle({ home: tmpHome })).toBeNull();
  });

  it('readMockBundle reads a valid mock bundle and normalizes provider codes', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-'));
    await writeFile(
      path.join(tmpHome, 'aikey-mock.json'),
      JSON.stringify({
        displayName: 'demo',
        providers: { claude: { apiKey: 'sk-ant', baseUrl: 'https://api.anthropic.com' } },
      })
    );
    const bundle = readMockBundle({ home: tmpHome });
    expect(bundle).not.toBeNull();
    expect(bundle.displayName).toBe('demo');
    // "claude" alias normalized to canonical "anthropic".
    expect(bundle.providers.anthropic).toEqual({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('readMockBundle returns null on a malformed file', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-'));
    await writeFile(path.join(tmpHome, 'aikey-mock.json'), '{ not json');
    expect(readMockBundle({ home: tmpHome })).toBeNull();
  });

  it('resolveApiKeyBundle falls back to the mock when the server endpoint is unavailable', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-'));
    await writeFile(
      path.join(tmpHome, 'aikey-mock.json'),
      JSON.stringify({ displayName: 'demo', providers: { openai: { apiKey: 'sk-real' } } })
    );
    // Server endpoint is "not supported yet" → fetch rejects (404/network). Must
    // degrade to the local mock, not throw.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('404 not supported'));
    try {
      const bundle = await resolveApiKeyBundle({ home: tmpHome });
      expect(bundle).not.toBeNull();
      expect(bundle.source).toBe('mock');
      expect(bundle.providers.openai.apiKey).toBe('sk-real');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

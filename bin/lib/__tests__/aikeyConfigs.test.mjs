// Tests for bin/lib/aikey.mjs::applyToConfigs — the "config-file direct-write"
// half of token distribution. Writes the claimed gateway key into the LOCAL
// runtime configs (~/.claude/settings.json, ~/.codex/auth.json, ~/.codex/config.toml)
// WITHOUT clobbering unrelated keys or [projects.*] blocks, and backs up first.
//
// All paths are redirected under a temp `home` so the test never touches the
// developer's real ~/.claude or ~/.codex.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyClaimedSecret,
  applyToConfigs,
  resolveClaudeBaseUrl,
  resolveCodexBaseUrl,
  writeAikeyEnv,
  validateClaimedSecret,
  isRoutableHost,
} from '../aikey.mjs';
import { mapTierModels } from '../tokenDistribution.mjs';

describe('applyToConfigs — Claude settings.json', () => {
  let home;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-cfg-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('deep-merges env and preserves unrelated top-level keys + existing env keys', async () => {
    const file = path.join(home, '.claude', 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        {
          // Unrelated top-level keys that MUST survive the merge.
          hooks: { Stop: [{ type: 'command', command: 'echo bye' }] },
          model: 'claude-sonnet-4',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'old-secret',
            SOME_OTHER_VAR: 'keep-me',
          },
        },
        null,
        2
      )
    );

    const result = applyToConfigs({
      key: 'sk-new',
      endpoint: 'https://gw.example',
      tierModels: { haiku: 'glm-4.5-air', sonnet: 'glm-5.1', opus: 'glm-5.2' },
      runtimes: ['claude'],
      home,
    });

    const written = JSON.parse(await readFile(file, 'utf-8'));
    // Unrelated top-level keys preserved.
    expect(written.hooks).toBeDefined();
    expect(written.model).toBe('claude-sonnet-4');
    // env merged: new values written, pre-existing unrelated var kept.
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://gw.example');
    // AUTH_TOKEN (not API_KEY) is the one Claude Code honors for a custom gateway.
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-new');
    // Tier vars replace the old single ANTHROPIC_MODEL (no dual model source).
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air');
    expect(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.1');
    expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2');
    expect(written.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(written.env.SOME_OTHER_VAR).toBe('keep-me');

    const claude = result.runtimes.find((r) => r.runtime === 'claude');
    expect(claude.path).toBe(file);
    expect(claude.backupPath).toBeTruthy();
    expect(existsSync(claude.backupPath)).toBe(true);
  });

  it('creates ~/.claude/settings.json when none exists', async () => {
    const fresh = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-fresh-'));
    try {
      const file = path.join(fresh, '.claude', 'settings.json');
      applyToConfigs({
        key: 'sk-x',
        endpoint: 'https://gw',
        tierModels: { haiku: 'glm-5.2', sonnet: 'glm-5.2', opus: 'glm-5.2' },
        runtimes: ['claude'],
        home: fresh,
      });
      const written = JSON.parse(await readFile(file, 'utf-8'));
      expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-x');
      expect(written.env.ANTHROPIC_BASE_URL).toBe('https://gw');
      expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2');
      expect(written.env.ANTHROPIC_MODEL).toBeUndefined();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe('applyToConfigs — Codex auth.json', () => {
  it('fully replaces auth.json, dropping stale OAuth tokens and sibling keys', async () => {
    // Regression: a prior `codex login` (OAuth) leaves a `tokens` object here, and
    // Codex prefers those OAuth tokens over OPENAI_API_KEY. The old merge write
    // ({ ...auth, OPENAI_API_KEY }) kept `tokens`, so the claimed gateway key was
    // ignored. The fix is a full replace — only OPENAI_API_KEY survives.
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-codex-auth-'));
    try {
      const file = path.join(home, '.codex', 'auth.json');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify(
          {
            OPENAI_API_KEY: 'sk-old',
            tokens: { id_token: 'xxx', access_token: 'yyy', refresh_token: 'zzz' },
            custom_marker: 'preserve',
          },
          null,
          2
        )
      );

      applyToConfigs({
        key: 'sk-new',
        endpoint: 'https://gw',
        model: 'm',
        runtimes: ['codex'],
        home,
      });

      const written = JSON.parse(await readFile(file, 'utf-8'));
      expect(written).toEqual({ OPENAI_API_KEY: 'sk-new' });
      expect(written.tokens).toBeUndefined();
      expect(written.custom_marker).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('applyToConfigs — Codex config.toml (surgical, no TOML lib)', () => {
  it('sets model_provider/model, writes [model_providers.skg], and preserves [projects.*] verbatim', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-codex-toml-'));
    try {
      const file = path.join(home, '.codex', 'config.toml');
      await mkdir(path.dirname(file), { recursive: true });
      const seed = `# my codex config
model = "gpt-5"
model_provider = "openai"
approval_policy = "untrusted"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"

[projects.my-project]
path = "/Users/me/work"
autoupdate = true

[projects.my-project.history]
size = 1000
`;
      await writeFile(file, seed);

      applyToConfigs({
        key: 'sk-new',
        endpoint: 'https://gw.example',
        model: 'qwen-max',
        wireApi: 'chat',
        runtimes: ['codex'],
        home,
      });

      const out = await readFile(file, 'utf-8');

      // model + model_provider rewritten at top level.
      expect(out).toMatch(/^model = "qwen-max"/m);
      expect(out).toMatch(/^model_provider = "skg"/m);

      // The claimed gateway is always written into an isolated [model_providers.skg]
      // block so pre-existing providers like [model_providers.openai] are not clobbered.
      expect(out).toMatch(/\[model_providers\.skg\]/);
      expect(out).toMatch(/name = "skg"/);
      expect(out).toMatch(/base_url = "https:\/\/gw\.example"/);
      expect(out).toMatch(/wire_api = "chat"/);
      expect(out).toMatch(/requires_openai_auth = true/);

      // Existing provider sections survive untouched.
      expect(out).toMatch(/\[model_providers\.openai\]/);
      expect(out).toMatch(/name = "OpenAI"/);
      expect(out).toMatch(/base_url = "https:\/\/api\.openai\.com\/v1"/);

      // [projects.*] blocks — the whole point of surgical edits — survive intact.
      expect(out).toContain('[projects.my-project]');
      expect(out).toMatch(/path = "\/Users\/me\/work"/);
      expect(out).toContain('[projects.my-project.history]');
      expect(out).toMatch(/size = 1000/);

      // Backup created from the seed.
      expect(existsSync(`${file}.hermit-bak`)).toBe(true);
      expect(await readFile(`${file}.hermit-bak`, 'utf-8')).toBe(seed);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defaults the provider name to "skg" when no model_provider exists', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-aikey-codex-toml-bare-'));
    try {
      const file = path.join(home, '.codex', 'config.toml');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `# bare\napproval_policy = "untrusted"\n`);

      applyToConfigs({
        key: 'sk-new',
        endpoint: 'https://gw.example',
        model: 'qwen-max',
        wireApi: 'chat',
        runtimes: ['codex'],
        home,
      });

      const out = await readFile(file, 'utf-8');
      expect(out).toMatch(/^model_provider = "skg"/m);
      expect(out).toMatch(/^model = "qwen-max"/m);
      expect(out).toMatch(/\[model_providers\.skg\]/);
      expect(out).toMatch(/base_url = "https:\/\/gw\.example"/);
      // Pre-existing top-level key preserved.
      expect(out).toMatch(/approval_policy = "untrusted"/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveClaudeBaseUrl', () => {
  it('returns the v3 receipt anthropic endpoint', () => {
    expect(resolveClaudeBaseUrl({ endpoints: { anthropic: 'https://gw.example/cpamc-cc' } })).toBe(
      'https://gw.example/cpamc-cc'
    );
  });
  it('trims whitespace and tolerates a missing endpoints.anthropic', () => {
    expect(
      resolveClaudeBaseUrl({ endpoints: { anthropic: '  https://gw.example/cpamc-cc  ' } })
    ).toBe('https://gw.example/cpamc-cc');
    expect(resolveClaudeBaseUrl({})).toBe('');
  });
});

describe('resolveCodexBaseUrl', () => {
  it('appends /v1 to the v3 receipt OpenAI endpoint', () => {
    expect(resolveCodexBaseUrl({ endpoints: { openai: 'https://ai.skg.com/cpamc-openai' } })).toBe(
      'https://ai.skg.com/cpamc-openai/v1'
    );
  });
  it('does not duplicate an existing /v1 suffix', () => {
    expect(
      resolveCodexBaseUrl({ endpoints: { openai: 'https://ai.skg.com/cpamc-openai/v1' } })
    ).toBe('https://ai.skg.com/cpamc-openai/v1');
  });
  it('trims whitespace and tolerates a missing endpoints.openai', () => {
    expect(resolveCodexBaseUrl({ endpoints: { openai: '  https://gw.example/cpaopen  ' } })).toBe(
      'https://gw.example/cpaopen/v1'
    );
    expect(resolveCodexBaseUrl({})).toBe('');
  });
});

describe('applyClaimedSecret — per-runtime writes', () => {
  it('writes only Codex when runtimes=[codex] and leaves Claude untouched', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-codex-only-'));
    try {
      const result = applyClaimedSecret({
        secret: {
          key: 'sk-pool',
          endpoints: {
            anthropic: 'https://gw.example/cpamc-cc',
            openai: 'https://gw.example/cpaopen',
          },
        },
        choices: { model: 'qwen-max', wireApi: 'chat' },
        runtimes: ['codex'],
        home,
      });
      // Endpoints recorded; codex = receipt openai endpoint, claude absent.
      expect(result.endpoints.codex).toBe('https://gw.example/cpaopen/v1');
      expect(result.endpoints.claude).toBeUndefined();

      // Codex auth + config written.
      const auth = JSON.parse(await readFile(path.join(home, '.codex', 'auth.json'), 'utf-8'));
      expect(auth.OPENAI_API_KEY).toBe('sk-pool');
      const toml = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toMatch(/base_url = "https:\/\/gw\.example\/cpaopen\/v1"/);
      expect(toml).toMatch(/^model = "qwen-max"/m);

      // Claude NOT created.
      expect(existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
      // backup:false → no .hermit-bak files anywhere.
      expect(existsSync(path.join(home, '.codex', 'auth.json.hermit-bak'))).toBe(false);
      expect(existsSync(path.join(home, '.codex', 'config.toml.hermit-bak'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('writes both runtimes with DIFFERENT endpoints, Claude tier vars from modelIds', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-both-'));
    try {
      const secret = {
        key: 'sk-pool',
        endpoints: {
          anthropic: 'https://gw.example/cpamc-cc',
          openai: 'https://gw.example/cpaopen',
        },
        modelIds: ['GLM-4.5-Air', 'GLM-5.1', 'GLM-5.2'],
      };
      const result = applyClaimedSecret({
        secret,
        choices: { model: 'GLM-5.2', wireApi: 'responses' },
        runtimes: ['claude', 'codex'],
        home,
      });
      // Two distinct endpoints straight from the v3 receipt.
      expect(result.endpoints.claude).toBe('https://gw.example/cpamc-cc');
      expect(result.endpoints.codex).toBe('https://gw.example/cpaopen/v1');
      expect(result.endpoints.claude).not.toBe(result.endpoints.codex);
      // tierModels: all three tiers use the single chosen model.
      expect(result.tierModels).toEqual({ haiku: 'GLM-5.2', sonnet: 'GLM-5.2', opus: 'GLM-5.2' });

      const claude = JSON.parse(
        await readFile(path.join(home, '.claude', 'settings.json'), 'utf-8')
      );
      expect(claude.env.ANTHROPIC_BASE_URL).toBe('https://gw.example/cpamc-cc');
      expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-pool');
      // Tier vars: all three use the same chosen model.
      expect(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('GLM-5.2');
      expect(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('GLM-5.2');
      expect(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('GLM-5.2');
      // No ANTHROPIC_MODEL (tier vars cover it — no dual model source).
      expect(claude.env.ANTHROPIC_MODEL).toBeUndefined();

      // No .hermit-bak from a claim write.
      expect(existsSync(path.join(home, '.claude', 'settings.json.hermit-bak'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preflights every selected target before rotating any credential', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-transaction-'));
    try {
      const originalClaude = '{"env":{"ANTHROPIC_AUTH_TOKEN":"old-key"}}\n';
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'settings.json'), originalClaude);
      await mkdir(path.join(home, '.codex', 'config.toml'), { recursive: true });

      expect(() =>
        applyClaimedSecret({
          secret: {
            key: 'sk-new-key',
            endpoints: {
              anthropic: 'https://gw.example/cpamc-cc',
              openai: 'https://gw.example/cpaopen',
            },
          },
          runtimes: ['claude', 'codex'],
          home,
        })
      ).toThrow('不是普通文件');

      expect(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(
        originalClaude
      );
      expect(existsSync(path.join(home, '.codex', 'auth.json'))).toBe(false);
      expect(existsSync(path.join(home, 'aikey.env'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defaults wire_api to "responses" — Codex dropped "chat" support', async () => {
    // Codex rejects wire_api="chat" (openai/codex#7782 — "chat" is no longer
    // supported, must be "responses"). When the claim flow has no explicit
    // wireApi, the default MUST be "responses" so a freshly-claimed Codex config
    // boots on first run instead of erroring out.
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-wire-default-'));
    try {
      applyClaimedSecret({
        secret: { key: 'sk-pool', endpoints: { openai: 'https://gw.example/cpaopen' } },
        choices: { model: 'qwen-max' }, // no wireApi → default kicks in
        runtimes: ['codex'],
        home,
      });
      const toml = await readFile(path.join(home, '.codex', 'config.toml'), 'utf-8');
      expect(toml).toMatch(/wire_api = "responses"/);
      expect(toml).not.toMatch(/wire_api = "chat"/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves [projects.*] blocks in an existing Codex config', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-projects-'));
    try {
      const file = path.join(home, '.codex', 'config.toml');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `model = "gpt-5"\n[projects.my-project]\npath = "/Users/me/work"\nautoupdate = true\n`
      );

      applyClaimedSecret({
        secret: { key: 'sk-pool', endpoints: { openai: 'https://gw.example/cpaopen' } },
        choices: { model: 'qwen-max', wireApi: 'chat' },
        runtimes: ['codex'],
        home,
      });

      const out = await readFile(file, 'utf-8');
      expect(out).toContain('[projects.my-project]');
      expect(out).toMatch(/path = "\/Users\/me\/work"/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('throws when the secret has no key', () => {
    expect(() =>
      applyClaimedSecret({
        secret: { endpoints: { anthropic: 'https://gw' } },
        runtimes: ['claude'],
      })
    ).toThrow(/key/);
  });
});

describe('writeAikeyEnv — sync env file writer', () => {
  it('writes ~/.hermit/aikey.env with key + base_url per provider', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-write-env-'));
    try {
      const bundle = {
        displayName: 'agentcli',
        providers: {
          anthropic: { apiKey: 'sk-test-key-1234', baseUrl: 'https://gw.example/cpamc-cc' },
          openai: { apiKey: 'sk-test-key-1234', baseUrl: 'https://gw.example/cpaopen' },
        },
      };
      writeAikeyEnv({ bundle, home });
      const envPath = path.join(home, 'aikey.env');
      expect(existsSync(envPath)).toBe(true);
      const content = await readFile(envPath, 'utf-8');
      expect(content).toContain('export ANTHROPIC_API_KEY="sk-test-key-1234"');
      expect(content).toContain('export ANTHROPIC_BASE_URL="https://gw.example/cpamc-cc"');
      expect(content).toContain('export OPENAI_API_KEY="sk-test-key-1234"');
      expect(content).toContain('export OPENAI_BASE_URL="https://gw.example/cpaopen"');
      expect(content).toContain('export OPENHERMIT_ACTIVE_KEY="agentcli"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('creates the hermit home directory if it does not exist', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-write-env-mkdir-'));
    const subHome = path.join(home, 'nested', 'hermit');
    try {
      const bundle = { displayName: 'test', providers: { anthropic: { apiKey: 'sk-x' } } };
      writeAikeyEnv({ bundle, home: subHome });
      expect(existsSync(path.join(subHome, 'aikey.env'))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('applyClaimedSecret — env file injection', () => {
  it('writes ~/.hermit/aikey.env alongside Claude/Codex configs', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-env-'));
    try {
      applyClaimedSecret({
        secret: {
          key: 'sk-envtest',
          endpoints: {
            anthropic: 'https://gw.example/cpamc-cc',
            openai: 'https://gw.example/cpaopen',
          },
          modelIds: ['glm-5.2'],
        },
        choices: { model: 'glm-5.2', wireApi: 'responses' },
        runtimes: ['claude', 'codex'],
        home,
      });

      const envPath = path.join(home, 'aikey.env');
      expect(existsSync(envPath)).toBe(true);
      const content = await readFile(envPath, 'utf-8');
      // The env file carries the key + base_url for external agents to source.
      expect(content).toContain('export ANTHROPIC_API_KEY="sk-envtest"');
      expect(content).toContain('export ANTHROPIC_BASE_URL="https://gw.example/cpamc-cc"');
      expect(content).toContain('export OPENAI_API_KEY="sk-envtest"');
      expect(content).toContain('export OPENAI_BASE_URL="https://gw.example/cpaopen/v1"');
      // Tier model vars are NOT in the env file (they're Claude-Code-specific,
      // written to settings.json env block; external agents specify model per-request).
      expect(content).not.toContain('ANTHROPIC_DEFAULT');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('writes only the selected provider exports for Claude-only and Pi-only claims', async () => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-claude-env-'));
    const piHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-claim-pi-env-'));
    try {
      applyClaimedSecret({
        secret: {
          key: 'sk-claude-only',
          endpoints: { anthropic: 'https://gw.example/cpamc-cc' },
          modelIds: ['glm-5.2'],
        },
        choices: { model: 'glm-5.2' },
        runtimes: ['claude'],
        home: claudeHome,
      });
      const claudeEnv = await readFile(path.join(claudeHome, 'aikey.env'), 'utf8');
      expect(claudeEnv).toContain('ANTHROPIC_API_KEY');
      expect(claudeEnv).not.toContain('OPENAI_API_KEY');

      applyClaimedSecret({
        secret: {
          key: 'sk-pi-only',
          endpoints: { openai: 'https://gw.example/cpaopen' },
          modelIds: ['glm-5.2'],
        },
        choices: { model: 'glm-5.2' },
        runtimes: ['pi'],
        home: piHome,
      });
      const piEnv = await readFile(path.join(piHome, 'aikey.env'), 'utf8');
      expect(piEnv).toContain('OPENAI_API_KEY');
      expect(piEnv).not.toContain('ANTHROPIC_API_KEY');
    } finally {
      await rm(claudeHome, { recursive: true, force: true });
      await rm(piHome, { recursive: true, force: true });
    }
  });
});

// validateClaimedSecret — the gateway returns non-functional sentinels (e.g. key
// "sk-homeless", base_url "https://gw/cpaopen" with a non-routable host) when it
// has no real key. These must be rejected so the working config is never
// overwritten with values that can never connect ("失败就是失败，失败就不要改配置").
describe('validateClaimedSecret — reject gateway placeholder/junk values', () => {
  it('rejects the sk-homeless placeholder key', () => {
    const r = validateClaimedSecret({ key: 'sk-homeless', endpoints: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/占位值/);
    expect(r.reason).not.toContain('sk-homeless');
  });
  it('rejects a non-routable endpoint host (bare "gw")', () => {
    const r = validateClaimedSecret({
      key: 'sk-prodkey-9876543210',
      endpoints: { openai: 'https://gw/cpaopen' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/不可路由/);
  });
  it('rejects an empty key', () => {
    expect(validateClaimedSecret({ key: '', endpoints: {} }).ok).toBe(false);
  });
  it('rejects remote cleartext, credential-bearing, metadata, and runtime-profile endpoints', () => {
    for (const secret of [
      { key: 'sk-prodkey-9876543210', endpoints: { openai: 'http://gw.example/cpaopen' } },
      {
        key: 'sk-prodkey-9876543210',
        endpoints: { openai: 'https://user:pass@gw.example/cpaopen' },
      },
      { key: 'sk-prodkey-9876543210', endpoints: { openai: 'https://169.254.169.254/latest' } },
      {
        key: 'sk-prodkey-9876543210',
        runtimeProfiles: { codex: { base_url: 'http://gw.example/cpaopen' } },
      },
    ]) {
      expect(validateClaimedSecret(secret).ok).toBe(false);
    }
  });

  it('allows cleartext only for loopback development endpoints', () => {
    expect(
      validateClaimedSecret({
        key: 'sk-prodkey-9876543210',
        endpoints: { openai: 'http://127.0.0.1:8080/cpaopen' },
      }).ok
    ).toBe(true);
  });

  it('accepts a real key + routable FQDN endpoints', () => {
    const r = validateClaimedSecret({
      key: 'sk-prodkey-9876543210',
      endpoints: { openai: 'https://gw.example/cpaopen', anthropic: 'https://gw.example/cpamc-cc' },
    });
    expect(r.ok).toBe(true);
  });
  it('applyClaimedSecret THROWS on a placeholder secret (no config touched)', () => {
    expect(() =>
      applyClaimedSecret({
        secret: { key: 'sk-homeless', endpoints: { openai: 'https://gw/cpaopen' } },
        runtimes: ['codex'],
      })
    ).toThrow(/占位值|不可路由|不可用/);
  });
});

describe('isRoutableHost — bare labels are not routable', () => {
  it('accepts FQDN / IPv4 / localhost, rejects a bare "gw"', () => {
    expect(isRoutableHost('gw.example.com')).toBe(true);
    expect(isRoutableHost('1.2.3.4')).toBe(true);
    expect(isRoutableHost('localhost')).toBe(true);
    expect(isRoutableHost('gw')).toBe(false);
  });
});

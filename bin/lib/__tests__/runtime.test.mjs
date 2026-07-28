// runtime.mjs — hermit-bridge runtime config: TOML ensure/migrate/normalize paths
// that WRITE to disk. env.mjs reads HERMIT_HOME at module load, so to exercise the
// fresh-install write path (ensureOpenHermitRuntimeConfig → writeFileSync) we run
// readHermitBridgeConfigState() in a fresh child process with HERMIT_HOME pointed
// at a temp dir. This is the regression guard for the 1.8.4 crash where four
// node:fs write helpers (writeFileSync / renameSync / cpSync / rmSync) were used
// but never imported — a latent bug that only fired when a config write was
// actually needed (fresh install or legacy migration), not on machines that
// already had a current-format config.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeUrl = 'file://' + resolve(here, '../runtime.mjs');

function readBridgeStateInFreshProcess(home) {
  // Fresh process so env.mjs picks up HERMIT_HOME at load time. Runs the same
  // ensure → write path hermit.mjs runs on startup (readHermitBridgeConfigState
  // → ensureOpenHermitRuntimeConfig → buildOpenHermitStarterConfig + writeFileSync).
  const script =
    `import(${JSON.stringify(runtimeUrl)}).then((m) => { ` +
    `m.readHermitBridgeConfigState(); ` +
    `process.stdout.write('OK'); ` +
    `}).catch((e) => { process.stderr.write((e && e.stack) ? e.stack : String(e)); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HERMIT_HOME: home },
    encoding: 'utf-8',
  });
}

describe('runtime.mjs hermit-bridge config ensure (fresh-install write path)', () => {
  it('writes the starter config on a fresh HERMIT_HOME without a ReferenceError', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermit-runtime-'));
    try {
      const result = readBridgeStateInFreshProcess(home);
      const stderr = result.stderr || '';

      // The 1.8.4 bug: four node:fs write helpers used but not imported.
      for (const name of ['writeFileSync', 'renameSync', 'cpSync', 'rmSync']) {
        expect(stderr, stderr).not.toContain(`${name} is not defined`);
      }
      expect(result.status, stderr).toBe(0);
      expect(result.stdout).toContain('OK');

      // Fresh ensure must have created the cc-connect config with starter content.
      const cfg = join(home, 'cc-connect', 'config.toml');
      expect(existsSync(cfg)).toBe(true);
      const raw = readFileSync(cfg, 'utf-8');
      expect(raw).toContain('[management]');
      expect(raw).toContain('[bridge]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('agentRuntimeCliSpec — digital-worker runtime CLI mapping', () => {
  it('maps supported agentTypes and rejects unknown ones', async () => {
    const m = await import(runtimeUrl);
    expect(m.agentRuntimeCliSpec('claudecode')).toEqual({
      agentType: 'claudecode',
      command: 'claude',
      pkg: '@anthropic-ai/claude-code',
      label: 'Claude Code',
    });
    expect(m.agentRuntimeCliSpec('codex')).toEqual({
      agentType: 'codex',
      command: 'codex',
      pkg: '@openai/codex',
      label: 'Codex',
    });
    expect(m.agentRuntimeCliSpec('cursor')).toBeNull();
    expect(m.agentRuntimeCliSpec(undefined)).toBeNull();
  });
});

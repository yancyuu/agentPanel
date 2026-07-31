// navigationCommandClaimResult.test.mjs — locks down the token-claim result panel.
//
// Regression: when the user selects ONLY Claude Code (not Codex) as the write
// runtime, the panel used to show a misleading yellow warning:
//   "Codex model — receipt 未返回 model_ids，Codex 模型未写入，请手动指定"
// That warning was shown unconditionally whenever `choices.model` was null, even
// though the user simply never selected Codex. The Codex row must only appear
// when Codex was actually selected; "no model" is a real warning only then.
import { describe, expect, it } from 'vitest';

import { buildClaimResultRows } from '../navigationCommand.mjs';

const baseApply = {
  endpoints: { claude: 'https://ai.skg.com/cpamc-cc', codex: '' },
  tierModels: { haiku: 'GLM-4.5-Air', sonnet: 'GLM-4.5-Air', opus: 'GLM-4.5-Air' },
};

function rowsFor({ runtimes, model }) {
  return buildClaimResultRows({
    apply: baseApply,
    choices: { model, wireApi: 'responses' },
    runtimes,
    envFilePath: '/Users/x/.hermit/aikey.env',
    backupRootPath: '/Users/x/.hermit/agentcli.env.bak',
    backupCreated: false,
    maskedKey: 'aim_…GyP8',
  });
}

describe('buildClaimResultRows — Codex model row', () => {
  it('omits the Codex model row entirely when Codex was not selected', () => {
    const rows = rowsFor({ runtimes: ['claude'], model: null });

    const codexModelRows = rows.filter(([label]) => label === 'Codex model');
    expect(codexModelRows).toHaveLength(0);
    // The misleading warning text must never appear when Codex wasn't chosen.
    expect(rows.some((r) => String(r[1]).includes('receipt 未返回 model_ids'))).toBe(false);
  });

  it('shows the chosen Codex model when Codex is selected and a model is present', () => {
    const rows = rowsFor({ runtimes: ['codex'], model: 'glm-5.2' });

    expect(rows).toContainEqual(['Codex model', 'glm-5.2', 'info']);
  });

  it('warns about a missing model only when Codex was actually selected', () => {
    const rows = rowsFor({ runtimes: ['codex'], model: null });

    expect(rows).toContainEqual([
      'Codex model',
      'receipt 未返回 model_ids，Codex 模型未写入，请手动指定',
      'warn',
    ]);
  });
});

describe('buildClaimResultRows — runtime summary', () => {
  it('labels a Pi-only write as Pi instead of Codex', () => {
    const rows = rowsFor({ runtimes: ['pi'], model: 'glm-5.2' });
    expect(rows).toContainEqual(['写入运行时', 'Pi', 'ok']);
  });
});

describe('buildClaimResultRows — written config file paths', () => {
  // Regression: the panel claimed "已写入 Claude/Codex 配置" but never showed the
  // file paths, so a silent write failure (notably on Windows) was invisible.
  // applyClaimedSecret returns one result per file with a `path` field; the panel
  // must surface each absolute path so the user can verify the write landed.
  function rowsWith(runtimesResults) {
    return buildClaimResultRows({
      apply: { ...baseApply, runtimes: runtimesResults },
      choices: { model: 'glm-5.2', wireApi: 'responses' },
      runtimes: ['claude', 'codex'],
      envFilePath: '/home/x/.hermit/aikey.env',
      backupRootPath: '/home/x/.hermit/agentcli.env.bak',
      backupCreated: false,
      maskedKey: 'aim_…GyP8',
    });
  }

  it('lists every written config file with its absolute path', () => {
    const rows = rowsWith([
      { runtime: 'claude', path: '/home/x/.claude/settings.json', changed: true },
      { runtime: 'codex-auth', path: '/home/x/.codex/auth.json', changed: true },
      { runtime: 'codex-config', path: '/home/x/.codex/config.toml', changed: true },
    ]);

    expect(rows).toContainEqual(['Claude 配置', '/home/x/.claude/settings.json（已写入）', 'ok']);
    expect(rows).toContainEqual(['Codex 认证', '/home/x/.codex/auth.json（已写入）', 'ok']);
    expect(rows).toContainEqual(['Codex 配置', '/home/x/.codex/config.toml（已写入）', 'ok']);
  });

  it('emits no config-path rows when apply.runtimes is absent', () => {
    const rows = rowsFor({ runtimes: ['claude'], model: 'glm-5.2' });
    expect(rows.some(([label]) => label === 'Claude 配置')).toBe(false);
  });
});

describe('buildClaimResultRows — system environment rows', () => {
  // The claim also writes the key into REAL environment variables (shell rc
  // block / launchctl / Windows user env). The panel must surface each written
  // env target so a silent env-write failure is visible; failures warn but
  // never fail the claim itself.
  function rowsWithEnv(envApply) {
    return buildClaimResultRows({
      apply: baseApply,
      choices: { model: 'glm-5.2', wireApi: 'responses' },
      runtimes: ['claude', 'codex'],
      envFilePath: '/home/x/.hermit/aikey.env',
      backupRootPath: '/home/x/.hermit/agentcli.env.bak',
      backupCreated: false,
      maskedKey: 'aim_…GyP8',
      envApply,
    });
  }

  it('shows ok rows for written env surfaces and warn rows for failures', () => {
    const rows = rowsWithEnv({
      ok: false,
      results: [
        { surface: '/home/x/.zshrc', ok: true },
        { surface: '/home/x/.bashrc', ok: true, skipped: true },
        { surface: 'launchctl', ok: false, message: 'boom' },
      ],
    });

    expect(rows).toContainEqual(['环境变量', '/home/x/.zshrc（已写入）', 'ok']);
    expect(rows).toContainEqual(['环境变量', 'launchctl 写入失败：boom', 'warn']);
    // Skipped surfaces (secondary rc did not exist) stay quiet.
    expect(rows.some((r) => String(r[1]).includes('.bashrc'))).toBe(false);
  });

  it('emits no env rows when envApply is absent', () => {
    const rows = rowsFor({ runtimes: ['claude'], model: 'glm-5.2' });
    expect(rows.some(([label]) => label === '环境变量')).toBe(false);
  });
});

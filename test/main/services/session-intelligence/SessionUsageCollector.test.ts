import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionUsageCollector } from '@main/services/session-intelligence/SessionUsageCollector';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

let tmpDir: string;
let claudeBase: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-session-usage-collector-'));
  claudeBase = path.join(tmpDir, '.claude');
  fs.mkdirSync(path.join(claudeBase, 'projects'), { recursive: true });
  setClaudeBasePathOverride(claudeBase);
  // Isolate Codex/Pi scanning from real user sessions on the dev machine.
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmpDir, '.pi', 'agent', 'sessions');
});

afterEach(() => {
  setClaudeBasePathOverride(null);
  delete process.env.CODEX_HOME;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SessionUsageCollector', () => {
  it('collects local Claude JSONL parse aggregate only', async () => {
    const collector = new SessionUsageCollector();

    const result = await collector.collect();

    expect(result.computedAt).toBeTruthy();
    expect(result.legacyParseResult.aggregate.sessions).toBe(0);
    expect(result).not.toHaveProperty('conversations');
  });
});

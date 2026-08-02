import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  scanProjectStats,
  scanSessions,
} from '@main/services/session-intelligence/SessionUsageParser';
import { encodePath, encodePathPortable, setClaudeBasePathOverride } from '@main/utils/pathDecoder';

let tmpDir: string;
let claudeBase: string;

function projectDirFor(workDir: string, encoded = encodePath(workDir)): string {
  return path.join(claudeBase, 'projects', encoded);
}

function writeSessionJsonl(filePath: string, workDir: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    {
      type: 'user',
      cwd: workDir,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Hello from user' },
    },
    {
      type: 'assistant',
      cwd: workDir,
      timestamp: '2026-01-01T00:00:10.000Z',
      message: {
        role: 'assistant',
        content: 'Assistant response',
        model: 'claude-sonnet-test',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 56,
          cache_creation_input_tokens: 78,
          total_tokens: 180,
        },
      },
    },
  ];
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function writeTopLevelUsageSessionJsonl(filePath: string, workDir: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    {
      type: 'user',
      cwd: workDir,
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'Hello from user',
    },
    {
      type: 'assistant',
      cwd: workDir,
      timestamp: '2026-01-01T00:00:10.000Z',
      content: 'Assistant response',
      model: 'claude-sonnet-test',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 56,
        cache_creation_input_tokens: 78,
        total_tokens: 180,
      },
    },
  ];
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-session-usage-parser-'));
  claudeBase = path.join(tmpDir, '.claude');
  fs.mkdirSync(path.join(claudeBase, 'projects'), { recursive: true });
  process.env.CODEX_HOME = path.join(tmpDir, '.codex');
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmpDir, '.pi', 'agent', 'sessions');
  setClaudeBasePathOverride(claudeBase);
});

afterEach(() => {
  vi.useRealTimers();
  setClaudeBasePathOverride(null);
  delete process.env.CODEX_HOME;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanProjectStats', () => {
  it('scans sessions stored in an alternate project directory candidate', async () => {
    const workDir = path.join(tmpDir, 'hermit_project');
    const portableDir = encodePathPortable(workDir);
    expect(portableDir).not.toBe(encodePath(workDir));
    writeSessionJsonl(
      path.join(projectDirFor(workDir, portableDir), 'session-portable.jsonl'),
      workDir
    );

    const stats = await scanProjectStats(workDir);

    expect(stats).toEqual({
      sessions: 1,
      messages: 2,
      tokensIn: 12,
      tokensOut: 34,
      cacheRead: 56,
      cacheCreation: 78,
      totalTokens: 180,
      durationMs: 10_000,
    });
  });

  it('prefers Claude total_tokens over recomputing cache-inclusive totals', async () => {
    const workDir = path.join(tmpDir, 'claude-total-tokens-project');
    const sessionPath = path.join(projectDirFor(workDir), 'session-total-tokens.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: 'assistant',
        cwd: workDir,
        timestamp: '2026-01-01T00:00:10.000Z',
        message: {
          role: 'assistant',
          content: 'Assistant response',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 56,
            cache_creation_input_tokens: 78,
            total_tokens: 46,
          },
        },
      })}\n`
    );

    const stats = await scanProjectStats(workDir);
    const result = await scanSessions();
    const session = result.sessions.find((item) => item.projectPath === workDir);

    expect(stats).toMatchObject({
      tokensIn: 12,
      tokensOut: 34,
      cacheRead: 56,
      cacheCreation: 78,
      totalTokens: 46,
    });
    expect(session?.tokens.total).toBe(46);
    expect(result.aggregate.tokens.total).toBe(46);
  });

  it('uses the upload totalTokens calculation when total_tokens is missing', async () => {
    const workDir = path.join(tmpDir, 'claude-missing-total-project');
    const sessionPath = path.join(projectDirFor(workDir), 'session-missing-total.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: 'assistant',
        cwd: workDir,
        timestamp: '2026-01-01T00:00:10.000Z',
        message: {
          role: 'assistant',
          content: 'Assistant response',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 56,
            cache_creation_input_tokens: 78,
          },
        },
      })}\n`
    );

    const stats = await scanProjectStats(workDir);
    const result = await scanSessions();
    const session = result.sessions.find((item) => item.projectPath === workDir);

    expect(stats).toMatchObject({
      tokensIn: 12,
      tokensOut: 34,
      cacheRead: 56,
      cacheCreation: 78,
      totalTokens: 180,
    });
    expect(session?.tokens.total).toBe(180);
    expect(result.aggregate.tokens.total).toBe(180);
  });

  it('includes top-level assistant usage in total tokens', async () => {
    const workDir = path.join(tmpDir, 'top_level_usage_project');
    writeTopLevelUsageSessionJsonl(
      path.join(projectDirFor(workDir), 'session-top-level.jsonl'),
      workDir
    );

    const stats = await scanProjectStats(workDir);

    expect(stats).toMatchObject({
      tokensIn: 12,
      tokensOut: 34,
      cacheRead: 56,
      cacheCreation: 78,
      totalTokens: 180,
    });
  });
});

describe('scanSessions', () => {
  it('uses the server-style half-open UTC 7-day date bucket', async () => {
    const nowMs = Date.parse('2026-07-09T12:00:00.000Z');
    vi.setSystemTime(nowMs);
    const workDir = path.join(tmpDir, 'recent-window-project');
    const sessionPath = path.join(projectDirFor(workDir), 'session-recent-window.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const assistantLine = (timestamp: string, tokens: number) =>
      JSON.stringify({
        type: 'assistant',
        cwd: workDir,
        timestamp,
        message: {
          role: 'assistant',
          content: `usage ${tokens}`,
          usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens },
        },
      });
    fs.writeFileSync(
      sessionPath,
      [
        assistantLine('2026-07-03T00:00:00.000Z', 10),
        assistantLine('2026-07-09T23:59:59.999Z', 20),
        assistantLine('2026-07-10T00:00:00.000Z', 30),
        assistantLine('2026-07-02T23:59:59.999Z', 40),
      ].join('\n') + '\n'
    );

    const result = await scanSessions();

    expect(result.aggregate.events7d.map((event) => event.tokensTotal)).toEqual([10, 20]);
  });

  it('includes Codex token_count records in provider aggregates', async () => {
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '02');
    fs.mkdirSync(sessionDir, { recursive: true });
    const projectPath = path.join(tmpDir, 'codex-project');
    const eventTimestamp = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(
      path.join(sessionDir, 'rollout-session-1.jsonl'),
      `${JSON.stringify({
        timestamp: eventTimestamp,
        type: 'session_meta',
        payload: {
          type: 'session_meta',
          session_id: 'rollout-session-1',
          cwd: projectPath,
          model_provider: 'glm',
        },
      })}\n${JSON.stringify({
        timestamp: eventTimestamp,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          turn_id: 'turn-1',
          cwd: projectPath,
          model: 'glm-5.2',
          info: {
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 2,
              output_tokens: 4,
              reasoning_output_tokens: 1,
              total_tokens: 18,
            },
          },
        },
      })}\n`
    );

    const result = await scanSessions();

    expect(result.aggregate.byProvider.codex).toMatchObject({
      sessions: 1,
      messages: 1,
      tokensIn: 11,
      tokensOut: 5,
      cacheRead: 2,
      tokensTotal: 18,
    });
    expect(result.aggregate.events7d.some((event) => event.provider === 'codex')).toBe(true);
    expect(result.sessions.some((session) => session.provider === 'codex')).toBe(true);
  });

  it('includes Pi usage and deduplicates entries copied by clone/fork sessions', async () => {
    const piSessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR!;
    const projectPath = path.join(tmpDir, 'pi-project');
    const projectDir = path.join(piSessionsRoot, '--tmp-pi-project--');
    fs.mkdirSync(projectDir, { recursive: true });

    const originalMessages = [
      {
        type: 'message',
        id: 'user0001',
        parentId: null,
        timestamp: '2026-07-20T00:00:01.000Z',
        message: { role: 'user', content: 'Inspect Pi usage', timestamp: 1_784_505_601_000 },
      },
      {
        type: 'message',
        id: 'assist01',
        parentId: 'user0001',
        timestamp: '2026-07-20T00:00:02.000Z',
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-test',
          timestamp: 1_784_505_602_000,
          content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }],
          usage: {
            input: 10,
            output: 2,
            cacheRead: 3,
            cacheWrite: 1,
            totalTokens: 16,
          },
        },
      },
    ];
    const originalPath = path.join(
      projectDir,
      '2026-07-20T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl'
    );
    fs.writeFileSync(
      originalPath,
      [
        {
          type: 'session',
          version: 3,
          id: '00000000-0000-0000-0000-000000000001',
          timestamp: '2026-07-20T00:00:00.000Z',
          cwd: projectPath,
        },
        ...originalMessages,
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );

    fs.writeFileSync(
      path.join(projectDir, '2026-07-20T01-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl'),
      [
        {
          type: 'session',
          version: 3,
          id: '00000000-0000-0000-0000-000000000002',
          timestamp: '2026-07-20T01:00:00.000Z',
          cwd: projectPath,
          parentSession: originalPath,
        },
        ...originalMessages,
        {
          type: 'message',
          id: 'user0002',
          parentId: 'assist01',
          timestamp: '2026-07-20T01:00:01.000Z',
          message: { role: 'user', content: 'Continue', timestamp: 1_784_509_201_000 },
        },
        {
          type: 'message',
          id: 'assist02',
          parentId: 'user0002',
          timestamp: '2026-07-20T01:00:02.000Z',
          message: {
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-test',
            timestamp: 1_784_509_202_000,
            content: [{ type: 'text', text: 'Done' }],
            usage: {
              input: 5,
              output: 1,
              cacheRead: 2,
              cacheWrite: 0,
              totalTokens: 8,
            },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );

    const result = await scanSessions(Date.parse('2026-07-20T12:00:00.000Z'));

    expect(result.aggregate.byProvider.pi).toMatchObject({
      sessions: 2,
      messages: 4,
      tokensIn: 15,
      tokensOut: 3,
      cacheRead: 5,
      cacheCreation: 1,
      tokensTotal: 24,
    });
    expect(result.aggregate.tokens.total).toBe(24);
    expect(result.aggregate.events7d.filter((event) => event.provider === 'pi')).toHaveLength(2);
    expect(result.sessions.filter((session) => session.provider === 'pi')).toHaveLength(2);
    expect(result.sessions.find((session) => session.relPath.includes('0001'))?.toolCalls).toEqual({
      read: 1,
    });
  });

  it('does not sum cumulative total_token_usage snapshots (no double-count)', async () => {
    // Real Codex logs can carry ONLY cumulative `total_token_usage` (no
    // `last_token_usage`). Three snapshots 100 -> 200 -> 300 are cumulative;
    // the real per-turn total is 300, not 600. Summing snapshots would ~2x.
    const codexHome = path.join(tmpDir, '.codex');
    process.env.CODEX_HOME = codexHome;
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '02');
    fs.mkdirSync(sessionDir, { recursive: true });
    const tokenLine = (cumulative: number, ts: string) =>
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: cumulative,
              output_tokens: 0,
              total_tokens: cumulative,
            },
          },
        },
      });
    const base = '2026-07-02T00:';
    fs.writeFileSync(
      path.join(sessionDir, 'rollout-cumulative.jsonl'),
      `${tokenLine(100, base + '00:00.000Z')}\n${tokenLine(200, base + '01:00.000Z')}\n${tokenLine(300, base + '02:00.000Z')}\n`
    );

    const result = await scanSessions();

    expect(result.aggregate.byProvider.codex).toMatchObject({
      sessions: 1,
      messages: 3,
      tokensIn: 300, // deltas 100 + 100 + 100, NOT 100 + 200 + 300
      tokensTotal: 300,
    });
  });
});

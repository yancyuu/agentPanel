import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalSessionScanner } from '@main/services/session-intelligence/LocalSessionScanner';
import {
  encodePath,
  encodePathPortable,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';

let tmpDir: string;
let claudeBase: string;
let scanner: LocalSessionScanner;

function writeSessionJsonl(filePath: string, firstUserText = 'Hello from user'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: firstUserText },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
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

function writeTopLevelUsageSessionJsonl(filePath: string, firstUserText = 'Hello from user'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: firstUserText,
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
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

function projectDirFor(workDir: string, encoded = encodePath(workDir)): string {
  return path.join(claudeBase, 'projects', encoded);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-local-session-scanner-'));
  claudeBase = path.join(tmpDir, '.claude');
  fs.mkdirSync(path.join(claudeBase, 'projects'), { recursive: true });
  setClaudeBasePathOverride(claudeBase);
  scanner = new LocalSessionScanner();
});

afterEach(() => {
  setClaudeBasePathOverride(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalSessionScanner', () => {
  it('expands a nested session returned by scanSummaries', async () => {
    const workDir = '/tmp/hermit-project';
    writeSessionJsonl(path.join(projectDirFor(workDir), 'nested', 'session-1.jsonl'));

    const summaries = await scanner.scanSummaries(workDir, 'team-a');
    expect(summaries.map((summary) => summary.id)).toContain('session-1');

    const detail = await scanner.readSessionDetail(workDir, 'session-1');
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('session-1');
    expect(detail?.historyCount).toBe(2);
    expect(detail?.history[0]?.content).toBe('Hello from user');
    expect(summaries[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
    expect(detail).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
  });

  it('uses the upload totalTokens calculation when total_tokens is missing', async () => {
    const workDir = '/tmp/hermit-project';
    const filePath = path.join(projectDirFor(workDir), 'nested', 'session-missing-total.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
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

    const summaries = await scanner.scanSummaries(workDir, 'team-a');
    const detail = await scanner.readSessionDetail(workDir, 'session-missing-total');

    expect(summaries[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
    expect(detail).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
  });

  it('expands a nested session without a prior scan', async () => {
    const workDir = '/tmp/hermit-project';
    writeSessionJsonl(path.join(projectDirFor(workDir), 'nested', 'session-direct.jsonl'));

    const detail = await scanner.readSessionDetail(workDir, 'session-direct');
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('session-direct');
    expect(detail?.historyCount).toBe(2);
  });

  it('includes top-level assistant usage in summary and detail totals', async () => {
    const workDir = '/tmp/hermit-project';
    writeTopLevelUsageSessionJsonl(path.join(projectDirFor(workDir), 'nested', 'session-top-level.jsonl'));

    const summaries = await scanner.scanSummaries(workDir, 'team-a');
    const detail = await scanner.readSessionDetail(workDir, 'session-top-level');

    expect(summaries[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
    expect(detail).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      totalTokens: 180,
    });
  });

  it('keeps root-level session lookup working', async () => {
    const workDir = '/tmp/hermit-project';
    writeSessionJsonl(path.join(projectDirFor(workDir), 'session-root.jsonl'));

    const summaries = await scanner.scanSummaries(workDir, 'team-a');
    expect(summaries.map((summary) => summary.id)).toContain('session-root');

    const detail = await scanner.readSessionDetail(workDir, 'session-root');
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('session-root');
  });

  it('scans and expands sessions stored in an alternate project directory candidate', async () => {
    const workDir = '/tmp/hermit_project';
    const portableDir = encodePathPortable(workDir);
    expect(portableDir).not.toBe(encodePath(workDir));
    writeSessionJsonl(path.join(projectDirFor(workDir, portableDir), 'session-portable.jsonl'));

    const summaries = await scanner.scanSummaries(workDir, 'team-a');
    expect(summaries.map((summary) => summary.id)).toContain('session-portable');

    const detail = await scanner.readSessionDetail(workDir, 'session-portable');
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('session-portable');
  });
});

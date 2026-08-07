import { describe, expect, it } from 'vitest';

import {
  extractRecentToolActivity,
  formatToolPreview,
  type ToolActivityMessage,
} from '../leadToolActivity';

function msg(
  timestamp: string,
  toolCalls: { name: string; input: Record<string, unknown>; id?: string }[]
): ToolActivityMessage {
  return { timestamp, toolCalls };
}

describe('formatToolPreview', () => {
  it('extracts the bash command', () => {
    expect(formatToolPreview('Bash', { command: 'pnpm test' })).toBe('pnpm test');
  });

  it('extracts file_path for read/edit/write', () => {
    expect(formatToolPreview('Edit', { file_path: '/repo/src/index.ts' })).toBe(
      '/repo/src/index.ts'
    );
  });

  it('combines grep pattern and path', () => {
    expect(formatToolPreview('Grep', { pattern: 'TODO', path: '/repo/src' })).toBe(
      'TODO  (in /repo/src)'
    );
  });

  it('keeps pattern alone when no path', () => {
    expect(formatToolPreview('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('formats Task/Agent with subagent type and description', () => {
    expect(formatToolPreview('Task', { subagent_type: 'executor', description: 'fix bug' })).toBe(
      '[executor] fix bug'
    );
  });

  it('counts todos for TodoWrite', () => {
    expect(formatToolPreview('TodoWrite', { todos: [{}, {}, {}] })).toBe('3 todos');
  });

  it('falls back to the first string-valued arg for unknown tools', () => {
    expect(formatToolPreview('CustomTool', { note: 'hello world' })).toBe('hello world');
  });

  it('truncates long fallback previews', () => {
    const long = 'x'.repeat(120);
    expect(formatToolPreview('CustomTool', { note: long })).toBe(`${'x'.repeat(80)}…`);
  });

  it('returns empty string when nothing useful is present', () => {
    expect(formatToolPreview('Bash', {})).toBe('');
    expect(formatToolPreview('Unknown', { count: 5 })).toBe('');
  });
});

describe('extractRecentToolActivity', () => {
  it('returns nothing for an empty session', () => {
    expect(extractRecentToolActivity([], 5)).toEqual([]);
  });

  it('returns nothing when limit is zero or negative', () => {
    const messages = [
      msg('2026-06-13T00:00:00.000Z', [{ name: 'Bash', input: { command: 'ls' } }]),
    ];
    expect(extractRecentToolActivity(messages, 0)).toEqual([]);
    expect(extractRecentToolActivity(messages, -1)).toEqual([]);
  });

  it('flattens tool calls across messages and orders newest first', () => {
    const messages = [
      msg('2026-06-13T00:00:00.000Z', [{ name: 'Bash', input: { command: 'first' }, id: 't1' }]),
      msg('2026-06-13T00:00:05.000Z', [
        { name: 'Read', input: { file_path: '/a.ts' }, id: 't2' },
        { name: 'Edit', input: { file_path: '/b.ts' }, id: 't3' },
      ]),
    ];

    const result = extractRecentToolActivity(messages, 10);

    expect(result.map((a) => a.name)).toEqual(['Edit', 'Read', 'Bash']);
    expect(result[0]).toEqual({
      name: 'Edit',
      preview: '/b.ts',
      toolUseId: 't3',
      timestamp: '2026-06-13T00:00:05.000Z',
    });
  });

  it('respects the limit, keeping the most recent calls', () => {
    const messages = [
      msg('2026-06-13T00:00:00.000Z', [{ name: 'Bash', input: { command: 'old' }, id: 't1' }]),
      msg('2026-06-13T00:00:01.000Z', [{ name: 'Read', input: { file_path: '/a' }, id: 't2' }]),
      msg('2026-06-13T00:00:02.000Z', [{ name: 'Edit', input: { file_path: '/b' }, id: 't3' }]),
    ];

    const result = extractRecentToolActivity(messages, 2);

    expect(result.map((a) => a.name)).toEqual(['Edit', 'Read']);
  });

  it('inherits the owning message timestamp and normalizes Date objects', () => {
    const date = new Date('2026-06-13T00:00:00.000Z');
    const messages = [{ timestamp: date, toolCalls: [{ name: 'Bash', input: { command: 'ls' } }] }];

    const [activity] = extractRecentToolActivity(messages, 5);
    expect(activity?.timestamp).toBe('2026-06-13T00:00:00.000Z');
  });

  it('skips messages that have no tool calls', () => {
    const messages = [
      msg('2026-06-13T00:00:00.000Z', []),
      msg('2026-06-13T00:00:01.000Z', [{ name: 'Bash', input: { command: 'ls' }, id: 't1' }]),
    ];

    const result = extractRecentToolActivity(messages, 5);
    expect(result.map((a) => a.name)).toEqual(['Bash']);
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildSlashCommandMeta,
  buildStandaloneSlashCommandMeta,
  getKnownSlashCommand,
  isSupportedSlashCommandName,
  KNOWN_SLASH_COMMANDS,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';

describe('slashCommands', () => {
  it('exposes exactly the curated known commands', () => {
    expect(KNOWN_SLASH_COMMANDS.map((command) => command.command)).toEqual([
      '/compact',
      '/clear',
      '/reset',
      '/new',
      '/plan',
      '/model',
      '/effort',
      '/fast',
      '/cost',
      '/usage',
      '/workers',
    ]);
  });

  it('parses known standalone slash commands', () => {
    expect(parseStandaloneSlashCommand('  /compact keep kanban  ')).toEqual({
      name: 'compact',
      command: '/compact',
      args: 'keep kanban',
      raw: '/compact keep kanban',
      startIndex: 2,
      endIndex: 22,
    });
  });

  it('parses unknown standalone slash commands', () => {
    expect(parseStandaloneSlashCommand('/foo bar')).toEqual({
      name: 'foo',
      command: '/foo',
      args: 'bar',
      raw: '/foo bar',
      startIndex: 0,
      endIndex: 8,
    });
  });

  it('rejects slash-like text that is not a standalone command', () => {
    expect(parseStandaloneSlashCommand('please run /compact now')).toBeNull();
    expect(parseStandaloneSlashCommand('/')).toBeNull();
  });

  it('returns metadata for known commands only', () => {
    expect(getKnownSlashCommand('MODEL')?.description).toContain('Claude 模型');
    expect(getKnownSlashCommand('foo')).toBeNull();
  });

  it('validates slash-compatible command names', () => {
    expect(isSupportedSlashCommandName('review')).toBe(true);
    expect(isSupportedSlashCommandName('skill:name')).toBe(true);
    expect(isSupportedSlashCommandName('my_skill')).toBe(false);
    expect(isSupportedSlashCommandName('my skill')).toBe(false);
  });
});

describe('buildSlashCommandMeta', () => {
  it('lowercases and derives the command from the name when omitted', () => {
    expect(buildSlashCommandMeta('COMPACT')).toEqual({
      name: 'compact',
      command: '/compact',
      knownDescription: '压缩当前对话，并可附加需要保留的重点说明。',
    });
  });

  it('keeps a caller-provided command verbatim instead of deriving from name', () => {
    const meta = buildSlashCommandMeta('plan', 'fix the bug', '/plan');
    expect(meta.command).toBe('/plan');
    expect(meta.name).toBe('plan');
    expect(meta.args).toBe('fix the bug');
  });

  it('omits args and knownDescription when both are absent for an unknown command', () => {
    expect(buildSlashCommandMeta('foo')).toEqual({ name: 'foo', command: '/foo' });
  });

  it('trims surrounding whitespace in the name before lookup', () => {
    const meta = buildSlashCommandMeta('  workers  ');
    expect(meta.name).toBe('workers');
    expect(meta.knownDescription).toBeTruthy();
  });

  it('attaches knownDescription for a known command even without args', () => {
    const meta = buildSlashCommandMeta('model');
    expect(meta.knownDescription).toContain('Claude 模型');
  });
});

describe('buildStandaloneSlashCommandMeta', () => {
  it('returns null for non-command text', () => {
    expect(buildStandaloneSlashCommandMeta('just a message')).toBeNull();
    expect(buildStandaloneSlashCommandMeta('')).toBeNull();
    expect(buildStandaloneSlashCommandMeta('   ')).toBeNull();
  });

  it('parses a known command with args into full metadata', () => {
    expect(buildStandaloneSlashCommandMeta('/plan rebuild the api')).toEqual({
      name: 'plan',
      command: '/plan',
      args: 'rebuild the api',
      knownDescription: '进入计划模式，可附加要规划的任务描述。',
    });
  });

  it('parses an unknown command without knownDescription', () => {
    expect(buildStandaloneSlashCommandMeta('/custom')).toEqual({
      name: 'custom',
      command: '/custom',
    });
  });

  it('normalizes an uppercase command name', () => {
    expect(buildStandaloneSlashCommandMeta('/CLEAR')).toEqual({
      name: 'clear',
      command: '/clear',
      knownDescription: expect.any(String),
    });
  });
});

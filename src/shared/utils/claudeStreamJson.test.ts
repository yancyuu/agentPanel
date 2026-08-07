import { describe, expect, it } from 'vitest';

import { classifyClaudeStreamLine } from './claudeStreamJson';

describe('classifyClaudeStreamLine', () => {
  it('returns null for empty / whitespace-only lines', () => {
    expect(classifyClaudeStreamLine('')).toBeNull();
    expect(classifyClaudeStreamLine('   ')).toBeNull();
    expect(classifyClaudeStreamLine('\n\t')).toBeNull();
  });

  it('classifies a system init line carrying session_id + model', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
      model: 'claude-sonnet-4-6',
      cwd: '/Users/x/hermit',
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'session-init',
      sessionId: 'abc-123',
      model: 'claude-sonnet-4-6',
    });
  });

  it('treats a system line without session_id as unknown (no id to resume)', () => {
    expect(classifyClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({
      type: 'unknown',
    });
  });

  it('extracts text blocks from an assistant message (wrapped format)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello there' }],
      },
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'assistant',
      blocks: [{ kind: 'text', text: 'Hello there' }],
      messageId: 'msg_1',
    });
  });

  it('extracts tool_use blocks with name + input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
      },
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'assistant',
      blocks: [
        {
          kind: 'tool-use',
          toolName: 'Bash',
          toolInput: { command: 'ls -la' },
          toolId: 'toolu_1',
        },
      ],
      messageId: undefined,
    });
  });

  it('keeps all block kinds when an assistant message carries text + thinking + tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        content: [
          { type: 'thinking', thinking: 'planning...' },
          { type: 'text', text: 'Running a command' },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'assistant',
      messageId: 'msg_2',
      blocks: [
        { kind: 'thinking', text: 'planning...' },
        { kind: 'text', text: 'Running a command' },
        { kind: 'tool-use', toolName: 'Read', toolInput: { file_path: '/a' }, toolId: 'toolu_2' },
      ],
    });
  });

  it('drops empty text/thinking blocks but keeps tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', name: 'Grep' },
        ],
      },
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'assistant',
      blocks: [{ kind: 'tool-use', toolName: 'Grep', toolInput: undefined, toolId: undefined }],
      messageId: undefined,
    });
  });

  it('classifies a result line with the turn text + subtype + session_id', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
      session_id: 'abc-123',
      total_cost_usd: 0.01,
    });
    expect(classifyClaudeStreamLine(line)).toEqual({
      type: 'result',
      text: 'final answer',
      subtype: 'success',
      sessionId: 'abc-123',
    });
  });

  it('handles result lines missing result text or subtype', () => {
    expect(classifyClaudeStreamLine(JSON.stringify({ type: 'result' }))).toEqual({
      type: 'result',
      text: '',
      subtype: '',
      sessionId: undefined,
    });
  });

  it('classifies control_request / control_cancel_request as control-request', () => {
    expect(
      classifyClaudeStreamLine(
        JSON.stringify({
          type: 'control_request',
          request_id: 'req_1',
          request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
        })
      )
    ).toEqual({
      type: 'control-request',
      requestId: 'req_1',
      subtype: 'can_use_tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(classifyClaudeStreamLine(JSON.stringify({ type: 'control_cancel_request' }))).toEqual({
      type: 'control-request',
      requestId: undefined,
      subtype: undefined,
      toolName: undefined,
      toolInput: undefined,
    });
  });

  it('treats user/tool_result lines as unknown', () => {
    expect(
      classifyClaudeStreamLine(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'ok' }] },
        })
      )
    ).toEqual({ type: 'unknown' });
  });

  it('flags non-JSON lines as parse-error (keeps the raw line)', () => {
    expect(classifyClaudeStreamLine('not json at all')).toEqual({
      type: 'parse-error',
      line: 'not json at all',
    });
  });

  it('returns unknown for valid JSON we do not model', () => {
    expect(classifyClaudeStreamLine(JSON.stringify({ type: 'stream_event', delta: 'x' }))).toEqual({
      type: 'unknown',
    });
    // assistant with no content array
    expect(classifyClaudeStreamLine(JSON.stringify({ type: 'assistant', message: {} }))).toEqual({
      type: 'unknown',
    });
  });
});

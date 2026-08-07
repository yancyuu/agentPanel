import { EMPTY_METRICS } from '@main/types/chunks';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';
import { describe, expect, it } from 'vitest';

import type { EnhancedChunk, ParsedMessage } from '@renderer/types/data';

// transformChunksToConversation 是 chunk→会话展示项的核心纯函数（chunk-building
// 关键路径），此前零覆盖。这里用最小 EnhancedChunk fixture 验证 chunk 类型映射、
// 计数、顺序、isOngoing 与 compact 阶段编号契约。

const T0 = new Date('2026-06-13T10:00:00.000Z');
const T1 = new Date('2026-06-13T10:00:01.000Z');

function msg(partial: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'm-1',
    parentUuid: null,
    type: 'user',
    timestamp: T0,
    content: 'hello',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...partial,
  } as ParsedMessage;
}

function base(id: string) {
  return { id, startTime: T0, endTime: T1, durationMs: 0, metrics: EMPTY_METRICS };
}

const userChunk = (id: string, content = 'hi') =>
  ({
    ...base(id),
    chunkType: 'user',
    userMessage: msg({ content }),
    rawMessages: [],
  }) as EnhancedChunk;

const aiChunk = (id: string, text = 'ok') =>
  ({
    ...base(id),
    chunkType: 'ai',
    responses: [msg({ type: 'assistant', content: text })],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
  }) as EnhancedChunk;

const systemChunk = (id: string, output = 'done') =>
  ({
    ...base(id),
    chunkType: 'system',
    message: msg({ content: output }),
    commandOutput: output,
    rawMessages: [],
  }) as EnhancedChunk;

const compactChunk = (id: string) =>
  ({
    ...base(id),
    chunkType: 'compact',
    message: msg({ content: 'compacted' }),
    rawMessages: [],
  }) as EnhancedChunk;

describe('transformChunksToConversation', () => {
  it('returns an empty conversation for no chunks', () => {
    const conv = transformChunksToConversation([], []);
    expect(conv).toEqual({
      sessionId: '',
      items: [],
      totalUserGroups: 0,
      totalSystemGroups: 0,
      totalAIGroups: 0,
      totalCompactGroups: 0,
    });
  });

  it('maps each chunk type to the correct item type and counts each once', () => {
    const conv = transformChunksToConversation(
      [userChunk('u-1'), aiChunk('u-1'), systemChunk('u-1'), compactChunk('u-1')],
      []
    );
    expect(conv.items.map((i) => i.type)).toEqual(['user', 'ai', 'system', 'compact']);
    expect(conv.totalUserGroups).toBe(1);
    expect(conv.totalAIGroups).toBe(1);
    expect(conv.totalSystemGroups).toBe(1);
    expect(conv.totalCompactGroups).toBe(1);
  });

  it('counts are per-type and independent across repeats', () => {
    const conv = transformChunksToConversation([userChunk('u'), userChunk('u'), aiChunk('u')], []);
    expect(conv.totalUserGroups).toBe(2);
    expect(conv.totalAIGroups).toBe(1);
    expect(conv.totalSystemGroups).toBe(0);
    expect(conv.totalCompactGroups).toBe(0);
  });

  it('sessionId comes from the first chunk id', () => {
    const conv = transformChunksToConversation(
      [aiChunk('session-42'), userChunk('session-42')],
      []
    );
    expect(conv.sessionId).toBe('session-42');
  });

  it('preserves chunk order in the flattened items', () => {
    const conv = transformChunksToConversation(
      [aiChunk('s'), userChunk('s'), systemChunk('s'), aiChunk('s')],
      []
    );
    expect(conv.items.map((i) => i.type)).toEqual(['ai', 'user', 'system', 'ai']);
  });

  it('marks only the last AI group as ongoing when isOngoing is true', () => {
    const conv = transformChunksToConversation(
      [userChunk('s'), aiChunk('s'), aiChunk('s')],
      [],
      true
    );
    const aiItems = conv.items.filter((i) => i.type === 'ai');
    expect(aiItems).toHaveLength(2);
    const first = aiItems[0].group as { isOngoing?: boolean };
    const last = aiItems[1].group as { isOngoing?: boolean; status?: string };
    expect(last.isOngoing).toBe(true);
    expect(last.status).toBe('in_progress');
    expect(first.isOngoing).not.toBe(true);
  });

  it('does not mark any group ongoing when isOngoing is false', () => {
    const conv = transformChunksToConversation([userChunk('s'), aiChunk('s')], [], false);
    const aiItem = conv.items.find((i) => i.type === 'ai')!;
    expect((aiItem.group as { isOngoing?: boolean }).isOngoing).not.toBe(true);
  });

  it('assigns a compact phase number (>=2) to compact groups', () => {
    const conv = transformChunksToConversation([userChunk('s'), compactChunk('s')], []);
    const compactItem = conv.items.find((i) => i.type === 'compact') as
      | { type: 'compact'; group: { startingPhaseNumber?: number } }
      | undefined;
    expect(compactItem).toBeDefined();
    expect(compactItem!.group.startingPhaseNumber).toBeGreaterThanOrEqual(2);
  });
});

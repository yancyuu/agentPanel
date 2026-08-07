/**
 * teamSessionListMapper — mergeLocalAndCcSessions invariant tests.
 *
 * Regression guard for #20: a cc-only session (e.g. a Feishu listening
 * session that has no local Claude JSONL yet) is listed so the user can see
 * it is listening, but expanding it must NOT try to read a local detail file
 * (which 404s and surfaces the misleading "会话文件已不存在"). The merged
 * CcSession must therefore tag whether each entry is backed by a local file
 * via `hasLocalFile`.
 */
import { describe, expect, it } from 'vitest';

import { mergeLocalAndCcSessions } from '../teamSessionListMapper';

import type { LocalSessionSummary } from '../LocalSessionScanner';
import type { HermitBridgeSessionListItem } from '@shared/types/hermitBridge';

const PROJECT = 'team-x';

function localSummary(id: string): LocalSessionSummary {
  return {
    id,
    title: id,
    projectId: PROJECT,
    messageCount: 3,
    userMessageCount: 1,
    assistantMessageCount: 2,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 30,
    model: 'claude-sonnet',
    active: false,
    live: false,
    startTime: null,
    endTime: null,
    createdAt: '2026-06-14T10:00:00Z',
    updatedAt: '2026-06-14T10:00:00Z',
  };
}

function ccItem(id: string, platform = 'feishu'): HermitBridgeSessionListItem {
  return {
    id,
    name: id,
    session_key: id,
    agent_session_id: id,
    agent_type: 'claude-code' as HermitBridgeSessionListItem['agent_type'],
    active: true,
    live: true,
    history_count: 0,
    created_at: '2026-06-14T10:00:00Z',
    updated_at: '2026-06-14T10:00:00Z',
    last_message: null,
    platform,
  };
}

describe('mergeLocalAndCcSessions — hasLocalFile flag (#20)', () => {
  it('tags a cc-only session (no local JSONL) as hasLocalFile=false', () => {
    // A Feishu listening session reported by cc-connect but with no local
    // Claude JSONL yet. Expanding it must not attempt a local detail read.
    const merged = mergeLocalAndCcSessions([], [ccItem('oc_feishu_only')], PROJECT);

    const feishu = merged.find((s) => s.id === 'oc_feishu_only');
    expect(feishu, 'cc-only session present in merged list').toBeDefined();
    expect(feishu?.hasLocalFile).toBe(false);
  });

  it('tags a local session (JSONL-backed) as hasLocalFile=true', () => {
    const merged = mergeLocalAndCcSessions([localSummary('local-1')], [], PROJECT);

    const local = merged.find((s) => s.id === 'local-1');
    expect(local, 'local session present in merged list').toBeDefined();
    expect(local?.hasLocalFile).toBe(true);
  });

  it('tags a session backed by BOTH a local file and cc-connect as hasLocalFile=true', () => {
    // Same agent_session_id appears in the local scan AND cc-connect: the
    // local JSONL is authoritative, detail reads from it.
    const sharedId = 'shared-1';
    const merged = mergeLocalAndCcSessions([localSummary(sharedId)], [ccItem(sharedId)], PROJECT);

    const shared = merged.find((s) => s.id === sharedId);
    expect(shared, 'shared session appears once').toBeDefined();
    expect(merged.filter((s) => s.id === sharedId)).toHaveLength(1);
    expect(shared?.hasLocalFile).toBe(true);
  });

  it('flags each entry correctly in a mixed list', () => {
    const merged = mergeLocalAndCcSessions(
      [localSummary('local-a'), localSummary('shared-b')],
      [ccItem('shared-b'), ccItem('feishu-c'), ccItem('feishu-d')],
      PROJECT
    );

    const byId = new Map(merged.map((s) => [s.id, s.hasLocalFile]));
    expect(byId.get('local-a')).toBe(true);
    expect(byId.get('shared-b')).toBe(true);
    expect(byId.get('feishu-c')).toBe(false);
    expect(byId.get('feishu-d')).toBe(false);
  });

  it('dedupes equivalent Feishu oc_/c_ cc-only sessions and keeps the richer history', () => {
    const older = {
      ...ccItem('feishu-old'),
      session_key: 'feishu:oc_efa2fbf5d5bd75da117eaebb6bbc730d:ou_user',
      history_count: 0,
      updated_at: '2026-06-14T10:00:00Z',
    };
    const richer = {
      ...ccItem('feishu-rich'),
      session_key: 'feishu:c_efa2fbf5d5bd75da117eaebb6bbc730d:ou_user',
      history_count: 17,
      updated_at: '2026-06-14T11:00:00Z',
    };

    const merged = mergeLocalAndCcSessions([], [older, richer], PROJECT);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('feishu-rich');
    expect(merged[0].historyCount).toBe(17);
    expect(merged[0].sessionKey).toBe('feishu:c_efa2fbf5d5bd75da117eaebb6bbc730d:ou_user');
  });
});

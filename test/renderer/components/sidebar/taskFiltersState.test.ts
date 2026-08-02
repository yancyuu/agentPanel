import { describe, expect, it } from 'vitest';

import { taskMatchesStatus } from '../../../../src/renderer/components/sidebar/taskFiltersState';

describe('taskFiltersState', () => {
  it('treats needsFix as distinct from normal todo/done buckets', () => {
    const pendingNeedsFixTask = { status: 'pending', reviewState: 'needsFix' as const };
    // 仅有字段没有事件时，doing/completed 的 needsFix 不成立（字段只是派生输入，不是事实源）
    const inProgressNeedsFixTask = { status: 'in_progress', reviewState: 'needsFix' as const };
    const completedNeedsFixTask = { status: 'completed', reviewState: 'needsFix' as const };
    const normalPendingTask = { status: 'pending', reviewState: 'none' as const };

    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(inProgressNeedsFixTask, new Set(['needs_fix']))).toBe(false);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['needs_fix']))).toBe(false);
    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['todo']))).toBe(false);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['done']))).toBe(true);
    expect(taskMatchesStatus(normalPendingTask, new Set(['todo']))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ensureInboxGoalDirective,
  hasInboxGoalDirective,
  stripInboxGoalDirective,
} from './inboxGoalDirective';

describe('inbox goal directive', () => {
  it('adds /goal to private mail sent to an Agent', () => {
    expect(ensureInboxGoalDirective('请准备季度汇报')).toBe('/goal 请准备季度汇报');
  });

  it('does not inject the directive twice', () => {
    expect(ensureInboxGoalDirective('/goal 请准备季度汇报')).toBe('/goal 请准备季度汇报');
    expect(hasInboxGoalDirective('  /GOAL 请准备季度汇报')).toBe(true);
  });

  it('strips the transport directive from the displayed mail body', () => {
    expect(stripInboxGoalDirective('/goal 请准备季度汇报')).toBe('请准备季度汇报');
    expect(stripInboxGoalDirective('普通私信')).toBe('普通私信');
  });
});

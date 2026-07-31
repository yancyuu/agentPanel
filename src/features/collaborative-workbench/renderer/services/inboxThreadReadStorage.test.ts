import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getInboxThreadReadState,
  initializeInboxThreadReadState,
  isInboxThreadReadInitialized,
  markInboxThreadRead,
  subscribeInboxThreadRead,
} from './inboxThreadReadStorage';

describe('inbox thread read storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('baselines historical mail as read only once', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInboxThreadRead(listener);

    expect(isInboxThreadReadInitialized()).toBe(false);
    initializeInboxThreadReadState([
      { key: 'team-a:old-mail', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    initializeInboxThreadReadState([
      { key: 'team-a:new-mail', updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);

    expect(isInboxThreadReadInitialized()).toBe(true);
    expect(getInboxThreadReadState()).toEqual({
      'team-a:old-mail': Date.parse('2026-01-01T00:00:00.000Z'),
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('stores a monotonic read watermark and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInboxThreadRead(listener);

    markInboxThreadRead('team-a:conversation-1', 100);
    markInboxThreadRead('team-a:conversation-1', 50);

    expect(getInboxThreadReadState()).toEqual({ 'team-a:conversation-1': 100 });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

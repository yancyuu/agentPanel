import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getInboxThreadReadState,
  markInboxThreadRead,
  subscribeInboxThreadRead,
} from './inboxThreadReadStorage';

describe('inbox thread read storage', () => {
  beforeEach(() => {
    localStorage.clear();
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

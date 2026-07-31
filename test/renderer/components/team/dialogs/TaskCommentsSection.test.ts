import {
  getVisibleTaskComments,
  sortTaskCommentsChronologically,
} from '@renderer/components/team/dialogs/taskCommentChronology';
import { describe, expect, it } from 'vitest';

import type { TaskComment } from '@shared/types';

function comment(id: string, createdAt: string): TaskComment {
  return { id, author: 'user', text: id, createdAt, type: 'regular' };
}

describe('TaskCommentsSection chronology', () => {
  const comments = [
    comment('newest', '2026-01-03T00:00:00.000Z'),
    comment('oldest', '2026-01-01T00:00:00.000Z'),
    comment('middle', '2026-01-02T00:00:00.000Z'),
  ];

  it('renders collaboration records from oldest to newest', () => {
    expect(sortTaskCommentsChronologically(comments).map((item) => item.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('keeps the most recent page while preserving chronological reading order', () => {
    expect(getVisibleTaskComments(comments, 2).map((item) => item.id)).toEqual([
      'middle',
      'newest',
    ]);
  });
});

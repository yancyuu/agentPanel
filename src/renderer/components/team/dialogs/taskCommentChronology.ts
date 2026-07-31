import type { TaskComment } from '@shared/types';

export function sortTaskCommentsChronologically(comments: TaskComment[]): TaskComment[] {
  return [...comments].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

export function getVisibleTaskComments(
  comments: TaskComment[],
  visibleCount: number
): TaskComment[] {
  const sorted = sortTaskCommentsChronologically(comments);
  return sorted.slice(Math.max(0, sorted.length - visibleCount));
}

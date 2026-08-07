import { useMemo, useSyncExternalStore } from 'react';

import {
  getTaskSnapshot,
  getUnreadCount,
  subscribeTask,
} from '@renderer/services/taskActivityReadStorage';
import { getTaskDeliveryActivityItems } from '@renderer/utils/taskActivityItems';

import type { Delivery } from '@shared/types';

/**
 * 任务未读动态数（以交付 deliveries 为准，取代已删除的评论未读）。
 */
export function useUnreadActivityCount(
  teamName: string,
  taskId: string,
  task: { deliveries?: Delivery[] }
): number {
  const items = useMemo(() => getTaskDeliveryActivityItems(task), [task]);
  return useSyncExternalStore(
    (listener) => subscribeTask(teamName, taskId, listener),
    () => {
      const entry = getTaskSnapshot(teamName, taskId);
      const state = entry ? { [`${teamName}/${taskId}`]: entry } : {};
      return getUnreadCount(state, teamName, taskId, items);
    }
  );
}

import type { Delivery } from '@shared/types';

/** 任务动态条目（未读计数的最小形状） */
export interface TaskActivityItem {
  id: string;
  createdAt: string;
}

/**
 * 任务的交付动态条目（deliveries → 未读/最新动态投影）。
 * 任务评论删除后，「任务有新动态」以交付为准。
 */
export function getTaskDeliveryActivityItems(task: {
  deliveries?: Delivery[];
}): TaskActivityItem[] {
  return (task.deliveries ?? []).map((delivery) => ({
    id: `delivery:${delivery.version}`,
    createdAt: delivery.deliveredAt,
  }));
}

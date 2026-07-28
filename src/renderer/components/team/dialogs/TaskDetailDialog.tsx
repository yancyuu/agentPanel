import React from 'react';

import { TaskDetailPanel } from './TaskDetailPanel';

import type { TaskDetailPanelProps } from './TaskDetailPanel';

export type TaskDetailDialogProps = Omit<TaskDetailPanelProps, 'presentation'>;

export const TaskDetailDialog = (props: Readonly<TaskDetailDialogProps>): React.JSX.Element =>
  React.createElement(TaskDetailPanel, { ...props, presentation: 'dialog' });

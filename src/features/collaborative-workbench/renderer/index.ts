export { type CollaborativeInboxState, useCollaborativeInbox } from './hooks/useCollaborativeInbox';
export {
  AppNavigationRail,
  type AppNavigationRailProps,
  getWorkbenchNavigationArea,
  type WorkbenchNavigationArea,
} from './ui/AppNavigationRail';
export { CollaborativeInboxView } from './ui/CollaborativeInboxView';
export { InboxTaskList, type InboxTaskListProps } from './ui/InboxTaskList';
export { InboxTaskRow, type InboxTaskRowProps } from './ui/InboxTaskRow';
export { WorkbenchPageHeader, type WorkbenchPageHeaderProps } from './ui/WorkbenchPageHeader';
export {
  getGlobalTaskKey,
  type InboxAttentionKind,
  type InboxProjectionOptions,
  type InboxTaskProjection,
  type InboxTaskView,
  projectInboxTasks,
} from './utils/inboxProjection';

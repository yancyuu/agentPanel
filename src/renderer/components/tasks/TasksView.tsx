import { CollaborativeInboxView } from '@features/collaborative-workbench/renderer';

export const TasksView = (): React.JSX.Element => (
  <div className="h-full min-h-0 min-w-0 overflow-hidden bg-page-canvas">
    <CollaborativeInboxView />
  </div>
);

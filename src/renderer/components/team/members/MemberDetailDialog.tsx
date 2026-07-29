import { useMemo } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@renderer/components/ui/dialog';
import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';
import { isLeadMember } from '@shared/utils/leadDetection';
import { Mail, Plus } from 'lucide-react';

import { MemberCapabilitiesSummary } from './MemberCapabilitiesSummary';
import { MemberDetailHeader } from './MemberDetailHeader';

import type { TeamLaunchParams } from '@renderer/store/slices/teamSlice';
import type {
  LeadActivityState,
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

interface MemberDetailDialogProps {
  open: boolean;
  member: ResolvedTeamMember | null;
  teamName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  isLaunchSettling?: boolean;
  leadActivity?: LeadActivityState;
  spawnEntry?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
  runtimeRunId?: string | null;
  launchParams?: TeamLaunchParams;
  onClose: () => void;
  onSendMessage: () => void;
  onAssignTask?: () => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  onRemoveMember?: () => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onUpdateRole?: (memberName: string, role: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
  onViewMemberChanges?: (memberName: string, filePath?: string) => void;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  in_progress: '处理中',
  completed: '已完成',
  deleted: '已删除',
};

const TASK_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  deleted: 3,
};

export const MemberDetailDialog = ({
  open,
  member,
  teamName,
  tasks,
  isTeamAlive,
  isTeamProvisioning,
  isLaunchSettling,
  leadActivity,
  spawnEntry,
  runtimeEntry,
  launchParams,
  onClose,
  onSendMessage,
  onAssignTask,
  onTaskClick,
  onUpdateRole,
  updatingRole,
}: MemberDetailDialogProps): React.JSX.Element | null => {
  const runtimeSummary = useMemo(
    () =>
      member
        ? resolveMemberRuntimeSummary(member, launchParams, spawnEntry, runtimeEntry)
        : undefined,
    [launchParams, member, runtimeEntry, spawnEntry]
  );
  const memberTasks = useMemo(() => {
    if (!member) return [];
    return tasks
      .filter((task) => task.owner === member.name && task.status !== 'deleted' && !task.deletedAt)
      .sort(
        (left, right) =>
          (TASK_STATUS_ORDER[left.status] ?? 99) - (TASK_STATUS_ORDER[right.status] ?? 99)
      );
  }, [member, tasks]);
  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <MemberDetailHeader
            member={member}
            runtimeSummary={runtimeSummary}
            isTeamAlive={isTeamAlive}
            isTeamProvisioning={isTeamProvisioning}
            leadActivity={isLeadMember(member) ? leadActivity : undefined}
            spawnStatus={spawnEntry?.status}
            spawnLaunchState={spawnEntry?.launchState}
            spawnLivenessSource={spawnEntry?.livenessSource}
            spawnRuntimeAlive={spawnEntry?.runtimeAlive}
            runtimeEntry={runtimeEntry}
            isLaunchSettling={isLaunchSettling}
            onUpdateRole={onUpdateRole ? (role) => onUpdateRole(member.name, role) : undefined}
            updatingRole={updatingRole}
          />
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" onClick={onAssignTask} disabled={!onAssignTask}>
            <Plus size={15} />
            新建任务
          </Button>
          <Button type="button" variant="outline" onClick={onSendMessage}>
            <Mail size={15} />
            发私信 · 进入收件箱
          </Button>
        </div>

        <section aria-labelledby="member-current-tasks-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3
              id="member-current-tasks-heading"
              className="text-sm font-medium text-[var(--color-text)]"
            >
              当前任务
            </h3>
            <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
              {memberTasks.length}
            </span>
          </div>
          {memberTasks.length > 0 ? (
            <div className="space-y-1.5">
              {memberTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-left transition-colors hover:border-[var(--color-border-hover)] hover:bg-[var(--color-surface-hover)]"
                  onClick={() => onTaskClick?.(task)}
                  disabled={!onTaskClick}
                >
                  <span className="min-w-0 truncate text-sm text-[var(--color-text)]">
                    {task.subject}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                    {TASK_STATUS_LABELS[task.status] ?? task.status}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
              暂无负责中的任务
            </div>
          )}
        </section>

        <MemberCapabilitiesSummary open={open} member={member} teamName={teamName} />
      </DialogContent>
    </Dialog>
  );
};

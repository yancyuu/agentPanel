import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@renderer/components/ui/dialog';
import {
  buildMemberLaunchDiagnosticsPayload,
  getMemberLaunchDiagnosticsErrorMessage,
  hasMemberLaunchDiagnosticsDetails,
  hasMemberLaunchDiagnosticsError,
} from '@renderer/utils/memberLaunchDiagnostics';
import {
  getRuntimeMemorySourceLabel,
  resolveMemberRuntimeSummary,
} from '@renderer/utils/memberRuntimeSummary';
import { isLeadMember } from '@shared/utils/leadDetection';
import { GitCompare, Mail, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { MemberCapabilitiesSummary } from './MemberCapabilitiesSummary';
import { MemberDetailHeader } from './MemberDetailHeader';
import { MemberLaunchDiagnosticsButton } from './MemberLaunchDiagnosticsButton';

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
  runtimeRunId,
  launchParams,
  onClose,
  onSendMessage,
  onAssignTask,
  onTaskClick,
  onRemoveMember,
  onRestartMember,
  onUpdateRole,
  updatingRole,
  onViewMemberChanges,
}: MemberDetailDialogProps): React.JSX.Element | null => {
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const runtimeSummary = useMemo(
    () =>
      member
        ? resolveMemberRuntimeSummary(member, launchParams, spawnEntry, runtimeEntry)
        : undefined,
    [launchParams, member, runtimeEntry, spawnEntry]
  );
  const memorySourceLabel = getRuntimeMemorySourceLabel(runtimeEntry);
  const memberTasks = useMemo(() => {
    if (!member) return [];
    return tasks
      .filter((task) => task.owner === member.name && task.status !== 'deleted' && !task.deletedAt)
      .sort(
        (left, right) =>
          (TASK_STATUS_ORDER[left.status] ?? 99) - (TASK_STATUS_ORDER[right.status] ?? 99)
      );
  }, [member, tasks]);
  const launchDiagnosticsPayload = useMemo(
    () =>
      member
        ? buildMemberLaunchDiagnosticsPayload({
            teamName,
            runId: runtimeRunId,
            memberName: member.name,
            spawnEntry,
            runtimeEntry,
          })
        : null,
    [member, runtimeEntry, runtimeRunId, spawnEntry, teamName]
  );
  const showCopyDiagnostics =
    launchDiagnosticsPayload != null &&
    hasMemberLaunchDiagnosticsError(launchDiagnosticsPayload) &&
    hasMemberLaunchDiagnosticsDetails(launchDiagnosticsPayload);
  const launchErrorMessage = launchDiagnosticsPayload
    ? getMemberLaunchDiagnosticsErrorMessage(launchDiagnosticsPayload)
    : undefined;

  useEffect(() => {
    if (!open || !member) return;
    setRestartError(null);
    setRestarting(false);
  }, [member, open]);

  if (!member) return null;

  const handleRestart = async (): Promise<void> => {
    if (!onRestartMember || restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      await onRestartMember(member.name);
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : '重启数字员工失败');
    } finally {
      setRestarting(false);
    }
  };

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
            发消息 · 进入收件箱
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

        <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)]">
            高级诊断
          </summary>
          <div className="space-y-3 border-t border-[var(--color-border)] p-3">
            {runtimeEntry?.pid ? (
              <div className="text-xs text-[var(--color-text-muted)]">
                运行进程 PID {runtimeEntry.pid}
                {memorySourceLabel ? ` · ${memorySourceLabel}` : ''}
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">暂无运行进程信息</div>
            )}
            <div className="flex flex-wrap gap-2">
              {onRestartMember ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleRestart()}
                  disabled={restarting}
                >
                  <RefreshCw size={14} className={restarting ? 'animate-spin' : undefined} />
                  {restarting ? '重启中…' : '重启员工'}
                </Button>
              ) : null}
              {onViewMemberChanges ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onViewMemberChanges(member.name)}
                >
                  <GitCompare size={14} />
                  查看变更
                </Button>
              ) : null}
              {onRemoveMember ? (
                <Button type="button" size="sm" variant="destructive" onClick={onRemoveMember}>
                  <Trash2 size={14} />
                  移除员工
                </Button>
              ) : null}
            </div>
            {launchErrorMessage ? (
              <div className="flex min-w-0 items-center gap-2 text-xs text-red-400">
                <span className="min-w-0 flex-1">{launchErrorMessage}</span>
                {launchDiagnosticsPayload && showCopyDiagnostics ? (
                  <MemberLaunchDiagnosticsButton
                    payload={launchDiagnosticsPayload}
                    label="复制诊断信息"
                    className="h-auto shrink-0 gap-1.5 px-2 py-1 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </details>

        <DialogFooter>
          {restartError ? <div className="text-xs text-red-400">{restartError}</div> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

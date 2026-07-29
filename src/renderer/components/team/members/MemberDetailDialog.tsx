import { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@renderer/components/ui/dialog';
import { useMemberStats } from '@renderer/hooks/useMemberStats';
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

import { MemberCapabilitiesSummary } from './MemberCapabilitiesSummary';
import { MemberDetailHeader } from './MemberDetailHeader';
import { MemberDetailStats } from './MemberDetailStats';
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
  /** Deprecated: team tasks UI has been removed, kept for compatibility with older callers/tests. */
  onAssignTask?: () => void;
  /** Deprecated: team tasks UI has been removed, kept for compatibility with older callers/tests. */
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  onRemoveMember?: () => void;
  onRestartMember?: (memberName: string) => Promise<void> | void;
  onUpdateRole?: (memberName: string, role: string | undefined) => Promise<void> | void;
  updatingRole?: boolean;
  onViewMemberChanges?: (memberName: string, filePath?: string) => void;
}

export const MemberDetailDialog = ({
  open,
  member,
  teamName,
  members,
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
  const restartInFlight =
    spawnEntry?.launchState === 'starting' ||
    spawnEntry?.launchState === 'runtime_pending_bootstrap' ||
    spawnEntry?.launchState === 'runtime_pending_permission';
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
    if (!open || !member) {
      return;
    }
    setRestartError(null);
    setRestarting(false);
  }, [member, open]);

  const {
    stats: memberStats,
    loading: statsLoading,
    error: statsError,
  } = useMemberStats(teamName, member?.name ?? null);

  const memberActivityCount = useMemo(() => {
    if (!member) return 0;
    const authoredComments = tasks.reduce((count, task) => {
      const comments = Array.isArray(task.comments) ? task.comments : [];
      return count + comments.filter((comment) => comment.author === member.name).length;
    }, 0);
    return Math.max(member.messageCount ?? 0, authoredComments);
  }, [member, tasks]);

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto sm:max-w-4xl">
        <div className="flex items-start gap-4">
          <DialogHeader className="shrink-0">
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
              onUpdateRole={
                onUpdateRole ? (newRole) => onUpdateRole(member.name, newRole) : undefined
              }
              updatingRole={updatingRole}
            />
          </DialogHeader>

          <MemberDetailStats
            stats={memberStats}
            statsLoading={statsLoading}
            statsError={statsError}
            activityCount={memberActivityCount}
          />
          <span className="sr-only">Activity{memberActivityCount}</span>
        </div>

        <MemberCapabilitiesSummary open={open} member={member} teamName={teamName} />

        <DialogFooter>
          {restartError ? (
            <div className="text-xs text-red-400">{restartError}</div>
          ) : launchErrorMessage ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-red-400">
              <span className="min-w-0 truncate" title={launchErrorMessage}>
                {launchErrorMessage}
              </span>
              {launchDiagnosticsPayload && showCopyDiagnostics ? (
                <MemberLaunchDiagnosticsButton
                  payload={launchDiagnosticsPayload}
                  label="复制诊断信息"
                  className="h-auto shrink-0 gap-1.5 px-2 py-1 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                />
              ) : null}
            </div>
          ) : runtimeEntry?.pid ? (
            <div className="text-xs text-[var(--color-text-muted)]">
              PID {runtimeEntry.pid}
              {memorySourceLabel ? ` · ${memorySourceLabel}` : ''}
            </div>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

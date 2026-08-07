import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '@renderer/api';
import { SessionContextPanel } from '@renderer/components/chat/SessionContextPanel/index';
import { TeamAssetsSection } from '@renderer/components/team/assets/TeamAssetsSection';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTabIdOptional } from '@renderer/contexts/useTabUIContext';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
  selectTeamMemberSnapshotsForName,
} from '@renderer/store/slices/teamSlice';
import { sumContextInjectionTokens } from '@renderer/utils/contextMath';
import { teamAvatarUrl } from '@renderer/utils/memberHelpers';
import {
  hasUnresolvedMemberSpawnStatus,
  MEMBER_SPAWN_STATUS_REFRESH_MS,
} from '@renderer/utils/memberSpawnStatusPolling';
import { formatProjectPath } from '@renderer/utils/pathDisplay';
import { buildTaskCountsByOwner, normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import {
  buildTaskChangeRequestOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { deriveContextMetrics } from '@shared/utils/contextMetrics';
import { isLeadMember } from '@shared/utils/leadDetection';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  FolderOpen,
  GitBranch,
  History,
  LibraryBig,
  Link,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CreateTaskDialog } from './dialogs/CreateTaskDialog';
import { EditTeamDialog } from './dialogs/EditTeamDialog';
import { ReviewDialog } from './dialogs/ReviewDialog';
import { RuntimeConfigDialog } from './dialogs/RuntimeConfigDialog';
import { AgentTuningDialog } from './members/AgentTuningDialog';
import { MemberCapabilitiesSummary } from './members/MemberCapabilitiesSummary';
import { MemberDetailDialog } from './members/MemberDetailDialog';

import type { ComponentProps } from 'react';

const ProjectEditorOverlay = lazy(() =>
  import('./editor/ProjectEditorOverlay').then((m) => ({ default: m.ProjectEditorOverlay }))
);
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';

import { MemberList } from './members/MemberList';
import { ChangeReviewDialog } from './review/ChangeReviewDialog';
import {
  getTeamPendingRepliesState,
  setTeamPendingRepliesState,
} from './sidebar/teamSidebarUiState';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { getLaunchJoinMilestonesFromMembers, getLaunchJoinState } from './provisioningSteps';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import {
  isLeadSessionMissing,
  shouldSuppressMissingLeadSessionFetch,
} from './teamSessionFetchGuards';

import type { ContextInjection } from '@renderer/types/contextInjection';
import type { Session } from '@renderer/types/data';
import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TaskRef,
  TeamAgentRuntimeEntry,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';
import type { ContextUsageLike } from '@shared/utils/contextMetrics';

interface TeamDetailViewProps {
  teamName: string;
  isPaneFocused?: boolean;
}

const TEAM_PENDING_REPLY_REFRESH_DELAY_MS = 10_000;

function areResolvedMembersEqual(
  prev: readonly ResolvedTeamMember[],
  next: readonly ResolvedTeamMember[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    const prevMember = prev[i];
    const nextMember = next[i];
    if (
      prevMember.name !== nextMember.name ||
      prevMember.status !== nextMember.status ||
      prevMember.currentTaskId !== nextMember.currentTaskId ||
      prevMember.color !== nextMember.color ||
      prevMember.agentType !== nextMember.agentType ||
      prevMember.role !== nextMember.role ||
      prevMember.workflow !== nextMember.workflow ||
      prevMember.providerId !== nextMember.providerId ||
      prevMember.model !== nextMember.model ||
      prevMember.effort !== nextMember.effort ||
      prevMember.cwd !== nextMember.cwd ||
      prevMember.gitBranch !== nextMember.gitBranch ||
      prevMember.removedAt !== nextMember.removedAt ||
      prevMember.runtimeAdvisory?.kind !== nextMember.runtimeAdvisory?.kind ||
      prevMember.runtimeAdvisory?.observedAt !== nextMember.runtimeAdvisory?.observedAt ||
      prevMember.runtimeAdvisory?.retryUntil !== nextMember.runtimeAdvisory?.retryUntil ||
      prevMember.runtimeAdvisory?.retryDelayMs !== nextMember.runtimeAdvisory?.retryDelayMs ||
      prevMember.runtimeAdvisory?.reasonCode !== nextMember.runtimeAdvisory?.reasonCode ||
      prevMember.runtimeAdvisory?.message !== nextMember.runtimeAdvisory?.message
    ) {
      return false;
    }
  }

  return true;
}

function useStableActiveMembers(
  members: readonly ResolvedTeamMember[] | undefined
): ResolvedTeamMember[] {
  const filteredMembers = useMemo(
    () => (members ?? []).filter((member) => !member.removedAt),
    [members]
  );
  const stableMembersRef = useRef(filteredMembers);

  if (!areResolvedMembersEqual(stableMembersRef.current, filteredMembers)) {
    stableMembersRef.current = filteredMembers;
  }

  return stableMembersRef.current;
}

type TeamMemberListBridgeProps = Omit<
  ComponentProps<typeof MemberList>,
  'leadActivity' | 'memberSpawnStatuses'
> & {
  teamName: string;
};
type TeamMemberDetailDialogBridgeProps = Omit<
  ComponentProps<typeof MemberDetailDialog>,
  'leadActivity' | 'spawnEntry' | 'runtimeEntry'
>;
interface LeadContextWatcherProps {
  teamName: string;
  tabId: string | null;
  projectId: string | null;
  leadSessionId: string | null;
  sessionHistoryKey: string;
  isThisTabActive: boolean;
  isTeamAlive?: boolean;
  sessions: readonly Session[];
  sessionsLoading: boolean;
}
interface LeadContextBridgeProps {
  teamName: string;
  tabId: string | null;
  projectId: string | null;
  leadSessionId: string | null;
  fallbackProjectRoot?: string;
}

function buildMemberSpawnStatusMap(
  memberSpawnStatuses: Record<string, MemberSpawnStatusEntry> | undefined
): Map<string, MemberSpawnStatusEntry> | undefined {
  if (!memberSpawnStatuses) {
    return undefined;
  }

  const map = new Map<string, MemberSpawnStatusEntry>(Object.entries(memberSpawnStatuses));
  return map.size > 0 ? map : undefined;
}

function buildTeamAgentRuntimeMap(
  runtimeSnapshot: Record<string, TeamAgentRuntimeEntry> | undefined
): Map<string, TeamAgentRuntimeEntry> | undefined {
  if (!runtimeSnapshot) {
    return undefined;
  }

  const map = new Map<string, TeamAgentRuntimeEntry>(Object.entries(runtimeSnapshot));
  return map.size > 0 ? map : undefined;
}

const TeamSpawnStatusWatcher = memo(function TeamSpawnStatusWatcher({
  teamName,
  isTeamProvisioning,
  isTeamAlive,
}: {
  teamName: string;
  isTeamProvisioning: boolean;
  isTeamAlive?: boolean;
}): null {
  const { leadActivity, memberSpawnStatuses, memberSpawnSnapshot, fetchMemberSpawnStatuses } =
    useStore(
      useShallow((s) => ({
        leadActivity: s.leadActivityByTeam[teamName],
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
        fetchMemberSpawnStatuses: s.fetchMemberSpawnStatuses,
      }))
    );

  useEffect(() => {
    const hasUnresolvedSpawn = hasUnresolvedMemberSpawnStatus(
      memberSpawnStatuses,
      memberSpawnSnapshot
    );
    const shouldFetchSpawnStatuses =
      isTeamProvisioning ||
      hasUnresolvedSpawn ||
      (memberSpawnStatuses == null &&
        (isTeamAlive === true || leadActivity === 'active' || leadActivity === 'idle'));
    if (shouldFetchSpawnStatuses) {
      void fetchMemberSpawnStatuses(teamName);
    }

    if (!isTeamProvisioning && !hasUnresolvedSpawn) {
      return;
    }

    const interval = window.setInterval(() => {
      void fetchMemberSpawnStatuses(teamName);
    }, MEMBER_SPAWN_STATUS_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    fetchMemberSpawnStatuses,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity,
    memberSpawnSnapshot,
    memberSpawnStatuses,
    teamName,
  ]);

  return null;
});

const TEAM_AGENT_RUNTIME_REFRESH_MS = 15_000;

const TeamAgentRuntimeWatcher = memo(function TeamAgentRuntimeWatcher({
  teamName,
  isTeamProvisioning,
  isTeamAlive,
  isThisTabActive,
}: {
  teamName: string;
  isTeamProvisioning: boolean;
  isTeamAlive?: boolean;
  isThisTabActive: boolean;
}): null {
  const { leadActivity, fetchTeamAgentRuntime } = useStore(
    useShallow((s) => ({
      leadActivity: s.leadActivityByTeam[teamName],
      fetchTeamAgentRuntime: s.fetchTeamAgentRuntime,
    }))
  );

  useEffect(() => {
    if (!isThisTabActive) return;
    const shouldWatch =
      isTeamProvisioning ||
      isTeamAlive === true ||
      leadActivity === 'active' ||
      leadActivity === 'idle';
    if (!shouldWatch) return;

    void fetchTeamAgentRuntime(teamName);
    const timer = window.setInterval(() => {
      void fetchTeamAgentRuntime(teamName);
    }, TEAM_AGENT_RUNTIME_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    fetchTeamAgentRuntime,
    isTeamAlive,
    isTeamProvisioning,
    isThisTabActive,
    leadActivity,
    teamName,
  ]);

  return null;
});

const LeadContextWatcher = memo(function LeadContextWatcher({
  teamName,
  tabId,
  projectId,
  leadSessionId,
  sessionHistoryKey,
  isThisTabActive,
  isTeamAlive,
  sessions,
  sessionsLoading,
}: LeadContextWatcherProps): null {
  const fetchSessionDetail = useStore((s) => s.fetchSessionDetail);
  const missingLeadSessionFetchKeyRef = useRef<string | null>(null);
  const missingLeadSessionFetchKey = useMemo(
    () => `${teamName}:${projectId ?? ''}:${leadSessionId ?? ''}:${sessionHistoryKey}`,
    [teamName, projectId, leadSessionId, sessionHistoryKey]
  );

  useEffect(() => {
    missingLeadSessionFetchKeyRef.current = null;
  }, [missingLeadSessionFetchKey]);

  useEffect(() => {
    if (!isThisTabActive) return;
    if (!tabId || !projectId || !leadSessionId) return;

    const leadSessionMissing = isLeadSessionMissing({
      leadSessionId,
      projectId,
      sessionsLoading,
      knownSessions: sessions,
    });
    if (leadSessionMissing) {
      missingLeadSessionFetchKeyRef.current = missingLeadSessionFetchKey;
      return;
    }

    const fetchLeadSessionDetail = () => {
      const suppressRepeatedFetch = shouldSuppressMissingLeadSessionFetch({
        leadSessionId,
        projectId,
        sessionsLoading,
        knownSessions: sessions,
        suppressionKey: missingLeadSessionFetchKeyRef.current,
        currentKey: missingLeadSessionFetchKey,
      });
      if (suppressRepeatedFetch) {
        return;
      }
      void fetchSessionDetail(projectId, leadSessionId, tabId, { silent: true });
    };

    fetchLeadSessionDetail();

    if (!isTeamAlive) return;

    const id = window.setInterval(() => {
      fetchLeadSessionDetail();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [
    fetchSessionDetail,
    isTeamAlive,
    isThisTabActive,
    leadSessionId,
    missingLeadSessionFetchKey,
    projectId,
    sessions,
    sessionsLoading,
    tabId,
  ]);

  return null;
});

const LeadContextBridge = memo(function LeadContextBridge({
  teamName,
  tabId,
  projectId,
  leadSessionId,
  fallbackProjectRoot,
}: LeadContextBridgeProps): React.JSX.Element | null {
  const {
    leadTabData,
    leadContextSnapshot,
    isContextPanelVisible,
    selectedContextPhase,
    setContextPanelVisibleForTab,
    setSelectedContextPhaseForTab,
    fetchSessionDetail,
  } = useStore(
    useShallow((s) => ({
      leadTabData: tabId ? (s.tabSessionData[tabId] ?? null) : null,
      leadContextSnapshot: s.leadContextByTeam[teamName] ?? null,
      isContextPanelVisible: tabId ? (s.tabUIStates.get(tabId)?.showContextPanel ?? false) : false,
      selectedContextPhase: tabId ? (s.tabUIStates.get(tabId)?.selectedContextPhase ?? null) : null,
      setContextPanelVisibleForTab: s.setContextPanelVisibleForTab,
      setSelectedContextPhaseForTab: s.setSelectedContextPhaseForTab,
      fetchSessionDetail: s.fetchSessionDetail,
    }))
  );
  const [isContextButtonHovered, setIsContextButtonHovered] = useState(false);

  const setContextPanelVisible = useCallback(
    (visible: boolean) => {
      if (!tabId) return;
      setContextPanelVisibleForTab(tabId, visible);
    },
    [setContextPanelVisibleForTab, tabId]
  );
  const setSelectedContextPhase = useCallback(
    (phase: number | null) => {
      if (!tabId) return;
      setSelectedContextPhaseForTab(tabId, phase);
    },
    [setSelectedContextPhaseForTab, tabId]
  );

  const leadSessionDetail = leadTabData?.sessionDetail ?? null;
  const leadConversation = leadTabData?.conversation ?? null;
  const leadSessionContextStats = leadTabData?.sessionContextStats ?? null;
  const leadSessionPhaseInfo = leadTabData?.sessionPhaseInfo ?? null;
  const leadSessionLoading = leadTabData?.sessionDetailLoading ?? false;
  const leadSessionLoaded = Boolean(
    leadSessionId && leadSessionDetail?.session?.id === leadSessionId
  );
  const leadSubagentCostUsd = useMemo(() => {
    const processes = leadSessionDetail?.processes;
    if (!processes || processes.length === 0) return undefined;
    const total = processes.reduce((sum, p) => sum + (p.metrics.costUsd ?? 0), 0);
    return total > 0 ? total : undefined;
  }, [leadSessionDetail?.processes]);
  const { allContextInjections, lastAssistantUsage, lastAssistantModelName } = useMemo(() => {
    if (!leadSessionLoaded || !leadSessionContextStats || !leadConversation?.items.length) {
      return {
        allContextInjections: [] as ContextInjection[],
        lastAssistantUsage: null as ContextUsageLike | null,
        lastAssistantModelName: undefined as string | undefined,
      };
    }

    const effectivePhase = selectedContextPhase;

    let targetAiGroupId: string | undefined;
    if (effectivePhase !== null && leadSessionPhaseInfo) {
      const phase = leadSessionPhaseInfo.phases.find((p) => p.phaseNumber === effectivePhase);
      if (phase) {
        targetAiGroupId = phase.lastAIGroupId;
      }
    }

    if (!targetAiGroupId) {
      const lastAiItem = [...leadConversation.items].reverse().find((item) => item.type === 'ai');
      if (lastAiItem?.type !== 'ai') {
        return {
          allContextInjections: [] as ContextInjection[],
          lastAssistantUsage: null,
          lastAssistantModelName: undefined,
        };
      }
      targetAiGroupId = lastAiItem.group.id;
    }

    const stats = leadSessionContextStats.get(targetAiGroupId);
    const injections = stats?.accumulatedInjections ?? [];

    let lastUsage: ContextUsageLike | null = null;
    let lastModelName: string | undefined;
    const targetItem = leadConversation.items.find(
      (item) => item.type === 'ai' && item.group.id === targetAiGroupId
    );
    if (targetItem?.type === 'ai') {
      const responses = targetItem.group.responses || [];
      for (let i = responses.length - 1; i >= 0; i--) {
        const msg = responses[i];
        if (msg.type === 'assistant' && msg.usage) {
          lastUsage = msg.usage;
          lastModelName = msg.model;
          break;
        }
      }
    }

    return {
      allContextInjections: injections,
      lastAssistantUsage: lastUsage,
      lastAssistantModelName: lastModelName,
    };
  }, [
    leadConversation,
    leadSessionContextStats,
    leadSessionLoaded,
    leadSessionPhaseInfo,
    selectedContextPhase,
  ]);
  const visibleContextTokens = useMemo(
    () => sumContextInjectionTokens(allContextInjections),
    [allContextInjections]
  );
  const contextMetrics = useMemo(
    () =>
      deriveContextMetrics({
        usage: lastAssistantUsage,
        modelName: lastAssistantModelName,
        contextWindowTokens: leadContextSnapshot?.contextWindowTokens ?? null,
        visibleContextTokens,
      }),
    [
      lastAssistantModelName,
      lastAssistantUsage,
      leadContextSnapshot?.contextWindowTokens,
      visibleContextTokens,
    ]
  );
  const contextUsedPercentLabel = useMemo(() => {
    const percent =
      contextMetrics.contextUsedPercentOfContextWindow ?? leadContextSnapshot?.contextUsedPercent;
    return percent === null || percent === undefined ? null : `${percent.toFixed(1)}%`;
  }, [contextMetrics.contextUsedPercentOfContextWindow, leadContextSnapshot?.contextUsedPercent]);

  if (!leadSessionId) {
    return null;
  }

  return (
    <>
      {isContextPanelVisible && (
        <div className="w-80 shrink-0">
          {leadSessionLoaded ? (
            <SessionContextPanel
              injections={allContextInjections}
              onClose={() => setContextPanelVisible(false)}
              projectRoot={leadSessionDetail?.session?.projectPath ?? fallbackProjectRoot}
              contextMetrics={contextMetrics}
              sessionMetrics={leadSessionDetail?.metrics}
              subagentCostUsd={leadSubagentCostUsd}
              phaseInfo={leadSessionPhaseInfo ?? undefined}
              selectedPhase={selectedContextPhase}
              onPhaseChange={setSelectedContextPhase}
              side="left"
            />
          ) : (
            <div
              className="flex h-full flex-col border-0 bg-[var(--color-surface)]"
              style={{ backgroundColor: 'var(--color-surface)' }}
            >
              <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)]">上下文</p>
                  <p className="text-[10px] text-[var(--color-text-muted)]">
                    {leadSessionLoading ? '加载中…' : '暂无会话'}
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                  onClick={() => setContextPanelVisible(false)}
                  aria-label={`关闭 ${teamName} 上下文面板`}
                >
                  ×
                </button>
              </div>
              <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-xs text-[var(--color-text-muted)]">
                  {leadSessionLoading ? '正在加载上下文…' : '打开 Lead 会话后可查看上下文。'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className="pointer-events-none fixed bottom-4 z-20"
        style={{ left: isContextPanelVisible ? 'calc(20rem + 1rem)' : '1rem' }}
      >
        <button
          onClick={() => {
            const next = !isContextPanelVisible;
            setContextPanelVisible(next);
            if (tabId && projectId) {
              void fetchSessionDetail(projectId, leadSessionId, tabId, { silent: true });
            }
          }}
          onMouseEnter={() => setIsContextButtonHovered(true)}
          onMouseLeave={() => setIsContextButtonHovered(false)}
          className="pointer-events-auto flex w-fit items-center gap-1 rounded-md px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-md transition-colors"
          style={{
            backgroundColor: isContextPanelVisible
              ? 'var(--context-btn-active-bg)'
              : isContextButtonHovered
                ? 'var(--context-btn-bg-hover)'
                : 'var(--context-btn-bg)',
            color: isContextPanelVisible
              ? 'var(--context-btn-active-text)'
              : 'var(--color-text-secondary)',
          }}
          title={
            leadSessionLoaded
              ? `会话：${leadSessionId}`
              : leadSessionLoading
                ? '正在加载上下文…'
                : leadSessionId
          }
        >
          {contextUsedPercentLabel ?? '上下文'}
        </button>
      </div>
    </>
  );
});

const TeamMemberListBridge = memo(function TeamMemberListBridge({
  teamName,
  ...props
}: TeamMemberListBridgeProps): React.JSX.Element {
  const { leadActivity, progress, memberSpawnStatuses, memberSpawnSnapshot, runtimeSnapshot } =
    useStore(
      useShallow((s) => ({
        leadActivity: s.leadActivityByTeam[teamName],
        progress: getCurrentProvisioningProgressForTeam(s, teamName),
        memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
        memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
        runtimeSnapshot: s.teamAgentRuntimeByTeam[teamName],
      }))
    );
  const memberSpawnStatusMap = useMemo(
    () => buildMemberSpawnStatusMap(memberSpawnStatuses),
    [memberSpawnStatuses]
  );
  const memberRuntimeMap = useMemo(
    () => buildTeamAgentRuntimeMap(runtimeSnapshot?.members),
    [runtimeSnapshot?.members]
  );
  const runtimeRunId = runtimeSnapshot?.runId ?? memberSpawnSnapshot?.runId ?? progress?.runId;
  const isLaunchSettling = useMemo(() => {
    if (progress?.state !== 'ready') {
      return false;
    }
    return getLaunchJoinState(
      getLaunchJoinMilestonesFromMembers({
        members: props.members,
        memberSpawnStatuses,
        memberSpawnSnapshot,
      })
    ).hasMembersStillJoining;
  }, [memberSpawnSnapshot, memberSpawnStatuses, progress?.state, props.members]);

  return (
    <MemberList
      {...props}
      leadActivity={leadActivity}
      memberSpawnStatuses={memberSpawnStatusMap}
      memberRuntimeEntries={memberRuntimeMap}
      runtimeRunId={runtimeRunId}
      isLaunchSettling={isLaunchSettling}
    />
  );
});

const TeamMemberDetailDialogBridge = memo(function TeamMemberDetailDialogBridge({
  teamName,
  member,
  ...props
}: TeamMemberDetailDialogBridgeProps): React.JSX.Element | null {
  const {
    leadActivity,
    liveMember,
    progress,
    launchMembers,
    memberSpawnStatuses,
    memberSpawnSnapshot,
    spawnEntry,
    runtimeRunId,
    runtimeEntry,
  } = useStore(
    useShallow((s) => ({
      leadActivity: s.leadActivityByTeam[teamName],
      liveMember: member ? selectResolvedMemberForTeamName(s, teamName, member.name) : null,
      progress: getCurrentProvisioningProgressForTeam(s, teamName),
      launchMembers: selectTeamMemberSnapshotsForName(s, teamName),
      memberSpawnStatuses: s.memberSpawnStatusesByTeam[teamName],
      memberSpawnSnapshot: s.memberSpawnSnapshotsByTeam[teamName],
      spawnEntry: member ? s.memberSpawnStatusesByTeam[teamName]?.[member.name] : undefined,
      runtimeRunId:
        s.teamAgentRuntimeByTeam[teamName]?.runId ??
        s.memberSpawnSnapshotsByTeam[teamName]?.runId ??
        getCurrentProvisioningProgressForTeam(s, teamName)?.runId,
      runtimeEntry: member ? s.teamAgentRuntimeByTeam[teamName]?.members[member.name] : undefined,
    }))
  );
  const isLaunchSettling = useMemo(() => {
    if (progress?.state !== 'ready') {
      return false;
    }
    return getLaunchJoinState(
      getLaunchJoinMilestonesFromMembers({
        members: launchMembers,
        memberSpawnStatuses,
        memberSpawnSnapshot,
      })
    ).hasMembersStillJoining;
  }, [launchMembers, memberSpawnSnapshot, memberSpawnStatuses, progress?.state]);

  return (
    <MemberDetailDialog
      {...props}
      teamName={teamName}
      member={liveMember ?? member}
      isLaunchSettling={isLaunchSettling}
      leadActivity={leadActivity}
      spawnEntry={spawnEntry}
      runtimeEntry={runtimeEntry}
      runtimeRunId={runtimeRunId}
    />
  );
});

/** Map agent harness type to CLI command name */
function getCommandForHarness(harness?: string): string {
  switch (harness) {
    case 'claudecode':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'cursor':
      return 'cursor';
    case 'gemini':
      return 'gemini';
    case 'iflow':
      return 'iflow';
    case 'kimi':
      return 'kimi';
    case 'qoder':
      return 'qoder';
    case 'pi':
      return 'pi';
    case 'acp':
      return 'acp';
    case 'tmux':
      return 'tmux';
    case 'devin':
      return 'devin';
    default:
      return 'claude';
  }
}

export const TeamDetailView = ({
  teamName,
  isPaneFocused = false,
}: TeamDetailViewProps): React.JSX.Element => {
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState<ResolvedTeamMember | null>(null);
  const [tuningMember, setTuningMember] = useState<ResolvedTeamMember | null>(null);
  const [taskAssignee, setTaskAssignee] = useState<ResolvedTeamMember | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [pendingRepliesByMember, setPendingRepliesByMember] = useState<Record<string, number>>(() =>
    getTeamPendingRepliesState(teamName)
  );
  const [removeMemberConfirm, setRemoveMemberConfirm] = useState<string | null>(null);
  const [updatingRoleLoading, setUpdatingRoleLoading] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const provisioningBannerRef = useRef<HTMLDivElement>(null);
  const wasProvisioningRef = useRef(false);

  // Set inert on background content when editor overlay is open (a11y focus trap)
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (editorOpen) {
      el.setAttribute('inert', '');
    } else {
      el.removeAttribute('inert');
    }
  }, [editorOpen]);

  // Listen for graph tab actions (open task, send message)
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const { teamName: tn, taskId } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || !taskId) return;
      handleTaskIdClick(taskId);
    };
    const onSendMsg = (e: Event) => {
      const { teamName: tn, memberName } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || typeof memberName !== 'string' || !memberName.trim()) return;
      const store = useStore.getState();
      store.setPendingInboxThreadIntent({
        teamName,
        memberName: memberName.trim(),
        compose: true,
      });
      store.openTasksTab();
    };
    const onOpenProfile = (e: Event) => {
      const { teamName: tn, memberName } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || !data) return;
      const member = members.find((m: { name: string }) => m.name === memberName);
      if (member) {
        setSelectedMember(member);
      }
    };
    window.addEventListener('graph:open-task', onOpenTask);
    window.addEventListener('graph:send-message', onSendMsg);
    window.addEventListener('graph:open-profile', onOpenProfile);

    // Task action events from graph
    const taskAction = (handler: (taskId: string) => void) => (e: Event) => {
      const { teamName: tn, taskId } = (e as CustomEvent).detail ?? {};
      if (tn !== teamName || !taskId) return;
      handler(taskId);
    };
    const onStartTask = taskAction((taskId) => {
      void (async () => {
        try {
          const task = data?.tasks.find((t: { id: string }) => t.id === taskId);
          const result = await startTaskByUser(teamName, taskId);
          try {
            if (result.notifiedOwner && task?.owner) {
              await api.teams.processSend(
                teamName,
                `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has started. Please begin working on it.`
              );
            }
          } catch (error) {
            console.error('Failed to notify task owner from graph action:', error);
          }
        } catch (error) {
          console.error('Failed to start task from graph action:', error);
        }
      })();
    });
    const onCompleteTask = taskAction((taskId) => {
      const task = data?.tasks.find((t: { id: string }) => t.id === taskId);
      if (task?.status === 'in_progress') return;
      void (async () => {
        try {
          await updateTaskStatus(teamName, taskId, 'completed');
        } catch (error) {
          console.error('Failed to complete task from graph action:', error);
        }
      })();
    });
    const onApproveTask = taskAction((taskId) => {
      void (async () => {
        try {
          await updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' });
        } catch (error) {
          console.error('Failed to approve task from graph action:', error);
        }
      })();
    });
    const onRequestReviewTask = taskAction((taskId) => {
      const task = data?.tasks.find((t: { id: string }) => t.id === taskId);
      if (task?.status === 'in_progress') return;
      void (async () => {
        try {
          await requestReview(teamName, taskId);
        } catch (error) {
          console.error('Failed to request task review from graph action:', error);
        }
      })();
    });
    const onRequestChangesTask = taskAction((taskId) => {
      setRequestChangesTaskId(taskId);
    });
    const onCancelTask = taskAction((taskId) => {
      const task = data?.tasks.find((t: { id: string }) => t.id === taskId);
      if (task?.status === 'in_progress') return;
      void (async () => {
        try {
          await updateTaskStatus(teamName, taskId, 'pending');
        } catch (error) {
          console.error('Failed to cancel task from graph action:', error);
        }
      })();
    });
    const onMoveBackToDoneTask = taskAction((taskId) => {
      void (async () => {
        try {
          await updateKanban(teamName, taskId, { op: 'remove' });
          await updateTaskStatus(teamName, taskId, 'completed');
        } catch (error) {
          console.error('Failed to move task back to done from graph action:', error);
        }
      })();
    });
    window.addEventListener('graph:start-task', onStartTask);
    window.addEventListener('graph:complete-task', onCompleteTask);
    window.addEventListener('graph:approve-task', onApproveTask);
    window.addEventListener('graph:request-review', onRequestReviewTask);
    window.addEventListener('graph:request-changes', onRequestChangesTask);
    window.addEventListener('graph:cancel-task', onCancelTask);
    window.addEventListener('graph:move-back-to-done', onMoveBackToDoneTask);
    return () => {
      window.removeEventListener('graph:open-task', onOpenTask);
      window.removeEventListener('graph:send-message', onSendMsg);
      window.removeEventListener('graph:open-profile', onOpenProfile);
      window.removeEventListener('graph:start-task', onStartTask);
      window.removeEventListener('graph:complete-task', onCompleteTask);
      window.removeEventListener('graph:approve-task', onApproveTask);
      window.removeEventListener('graph:request-review', onRequestReviewTask);
      window.removeEventListener('graph:request-changes', onRequestChangesTask);
      window.removeEventListener('graph:cancel-task', onCancelTask);
      window.removeEventListener('graph:move-back-to-done', onMoveBackToDoneTask);
    };
  });

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reviewDialogState, setReviewDialogState] = useState<{
    open: boolean;
    mode: 'agent' | 'task';
    memberName?: string;
    taskId?: string;
    initialFilePath?: string;
    taskChangeRequestOptions?: TaskChangeRequestOptions;
  }>({ open: false, mode: 'task' });

  // Session loading and filtering state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const {
    data,
    members,
    loading,
    error,
    projects,
    repositoryGroups,
    fetchSkillsCatalog,
    mcpFetchInstalled,
    initTabUIState,
    selectTeam,
    updateKanban,
    updateTaskStatus,
    requestReview,
    startTaskByUser,
    createTeamTask,
    deleteTeam,
    openTeamsTab,
    openTasksTab,
    setPendingInboxThreadIntent,
    closeTab,
    reviewActionError,
    restartMember,
    skipMemberForLaunch,
    removeMember,
    updateMemberRole,
    provisioningError,
    clearProvisioningError,
    isTeamProvisioning,
    refreshTeamMessagesHead,
    refreshMemberActivityMeta,
    syncTeamPendingReplyRefresh,
    launchParams,
    selectReviewFile,
    pendingReviewRequest,
    setPendingReviewRequest,
    teamSummaryDisplayName,
    fetchTeams,
  } = useStore(
    useShallow((s) => ({
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
      fetchSkillsCatalog: s.fetchSkillsCatalog,
      mcpFetchInstalled: s.mcpFetchInstalled,
      initTabUIState: s.initTabUIState,
      selectTeam: s.selectTeam,
      updateKanban: s.updateKanban,
      updateTaskStatus: s.updateTaskStatus,
      requestReview: s.requestReview,
      startTaskByUser: s.startTaskByUser,
      createTeamTask: s.createTeamTask,
      deleteTeam: s.deleteTeam,
      openTeamsTab: s.openTeamsTab,
      openTasksTab: s.openTasksTab,
      setPendingInboxThreadIntent: s.setPendingInboxThreadIntent,
      closeTab: s.closeTab,
      reviewActionError: s.reviewActionError,
      restartMember: s.restartMember,
      skipMemberForLaunch: s.skipMemberForLaunch,
      removeMember: s.removeMember,
      updateMemberRole: s.updateMemberRole,
      provisioningError: teamName ? (s.provisioningErrorByTeam[teamName] ?? null) : null,
      clearProvisioningError: s.clearProvisioningError,
      isTeamProvisioning: teamName ? isTeamProvisioningActive(s, teamName) : false,
      data: s.selectedTeamName === teamName ? s.selectedTeamData : null,
      members: selectResolvedMembersForTeamName(s, teamName),
      loading: s.selectedTeamName === teamName ? s.selectedTeamLoading : false,
      error: s.selectedTeamName === teamName ? s.selectedTeamError : null,
      refreshTeamMessagesHead: s.refreshTeamMessagesHead,
      refreshMemberActivityMeta: s.refreshMemberActivityMeta,
      syncTeamPendingReplyRefresh: s.syncTeamPendingReplyRefresh,
      launchParams: teamName ? s.launchParamsByTeam[teamName] : undefined,
      selectReviewFile: s.selectReviewFile,
      pendingReviewRequest: s.pendingReviewRequest,
      setPendingReviewRequest: s.setPendingReviewRequest,
      teamSummaryDisplayName: teamName ? s.teamByName[teamName]?.displayName : undefined,
      fetchTeams: s.fetchTeams,
    }))
  );

  const tabId = useTabIdOptional();
  const activeTabId = useStore((s) => s.activeTabId);
  const isThisTabActive = tabId ? activeTabId === tabId : false;
  const wasInteractiveRef = useRef(false);

  useEffect(() => {
    if (tabId) {
      initTabUIState(tabId);
    }
  }, [tabId, initTabUIState]);

  useEffect(() => {
    setPendingRepliesByMember(getTeamPendingRepliesState(teamName));
  }, [teamName]);

  useEffect(() => {
    setTeamPendingRepliesState(teamName, pendingRepliesByMember);
  }, [pendingRepliesByMember, teamName]);

  useEffect(() => {
    const projectPath = data?.config.projectPath;
    void fetchSkillsCatalog(projectPath ?? undefined);
    if (projectPath) {
      void mcpFetchInstalled(projectPath);
    }
  }, [data?.config.projectPath, fetchSkillsCatalog, mcpFetchInstalled]);

  useEffect(() => {
    const wasProvisioning = wasProvisioningRef.current;
    wasProvisioningRef.current = isTeamProvisioning;
    if (!wasProvisioning && isTeamProvisioning) {
      provisioningBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isTeamProvisioning]);

  // Open editor overlay when a file reveal is requested (e.g. from chip click)
  const pendingRevealFile = useStore((s) => s.editorPendingRevealFile);
  useEffect(() => {
    if (pendingRevealFile && data?.config.projectPath) {
      setEditorOpen(true);
    }
  }, [pendingRevealFile, data?.config.projectPath]);

  useEffect(() => {
    if (!teamName) {
      return;
    }
    void selectTeam(teamName);
  }, [teamName, selectTeam]);

  // Recovery: after HMR, all mounted TeamDetailView effects re-run simultaneously.
  // With CSS display-toggle (all tabs stay mounted), the last selectTeam() call wins
  // and other tabs get stuck with mismatched data (permanent skeleton).
  // Re-trigger selectTeam when this tab becomes active and store data is stale.
  const storedTeamName = data?.teamName;
  useEffect(() => {
    if (!isThisTabActive || !teamName || loading) return;
    if (storedTeamName != null && storedTeamName !== teamName) {
      void selectTeam(teamName);
    }
  }, [isThisTabActive, teamName, storedTeamName, loading, selectTeam]);

  useEffect(() => {
    const isInteractive = isThisTabActive && isPaneFocused;
    const justBecameInteractive = isInteractive && !wasInteractiveRef.current;
    wasInteractiveRef.current = isInteractive;
    if (!justBecameInteractive || !teamName) {
      return;
    }

    void (async () => {
      try {
        const headResult = await refreshTeamMessagesHead(teamName);
        if (headResult.feedChanged) {
          await refreshMemberActivityMeta(teamName);
        }
      } catch {
        // Best-effort refresh on tab focus.
      }
    })();
  }, [
    isPaneFocused,
    isThisTabActive,
    refreshMemberActivityMeta,
    refreshTeamMessagesHead,
    teamName,
  ]);

  // Load sessions for the team's project
  const projectId = useMemo(
    () => resolveProjectIdByPath(data?.config.projectPath, projects, repositoryGroups),
    [projects, repositoryGroups, data?.config.projectPath]
  );

  const leadSessionId = data?.config.leadSessionId ?? null;
  const pendingReplyRefreshSourceId = useId();
  const sessionHistoryKey = useMemo(
    () => (data?.config.sessionHistory ?? []).join('|'),
    [data?.config.sessionHistory]
  );

  // Keep team message state fresh while we are explicitly waiting for a reply.
  // This stays enabled even for hidden mounted tabs, because the waiting state
  // is renderer-local and should keep its lightweight polling until resolved.
  useEffect(() => {
    const hasPendingReplies = Object.keys(pendingRepliesByMember).length > 0;
    syncTeamPendingReplyRefresh(
      teamName,
      pendingReplyRefreshSourceId,
      Boolean(data?.isAlive) && hasPendingReplies,
      TEAM_PENDING_REPLY_REFRESH_DELAY_MS
    );

    return () => {
      syncTeamPendingReplyRefresh(teamName, pendingReplyRefreshSourceId, false);
    };
  }, [
    data?.isAlive,
    pendingRepliesByMember,
    pendingReplyRefreshSourceId,
    syncTeamPendingReplyRefresh,
    teamName,
  ]);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    setSessionsLoading(true);

    void (async () => {
      try {
        const result = await api.getSessions(projectId);
        if (!cancelled) {
          setSessions(result);
        }
      } catch {
        // Runtime sessions remain an internal context source and are best-effort.
      } finally {
        if (!cancelled) {
          setSessionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Live git branch tracking for the lead project and member worktrees
  const teamProjectPath = data?.config.projectPath?.trim() ?? null;
  const leadProjectPath = useMemo(() => {
    const explicitLeadPath = members.find((member) => isLeadMember(member))?.cwd?.trim();
    return explicitLeadPath && explicitLeadPath.length > 0 ? explicitLeadPath : teamProjectPath;
  }, [members, teamProjectPath]);
  const branchSyncPaths = useMemo(() => {
    const uniquePaths = new Map<string, string>();
    const addPath = (candidate: string | null | undefined): void => {
      const trimmed = candidate?.trim();
      if (!trimmed) return;
      const key = normalizePath(trimmed);
      if (!key || uniquePaths.has(key)) return;
      uniquePaths.set(key, trimmed);
    };

    addPath(leadProjectPath);
    for (const member of members) {
      addPath(member.cwd);
    }

    return Array.from(uniquePaths.values());
  }, [members, leadProjectPath]);
  useBranchSync(branchSyncPaths, { live: true });
  const trackedBranches = useStore(
    useShallow((s) =>
      Object.fromEntries(
        branchSyncPaths.map((projectPath) => {
          const normalizedPath = normalizePath(projectPath);
          return [normalizedPath, s.branchByPath[normalizedPath] ?? null] as const;
        })
      )
    )
  );
  const leadBranch = leadProjectPath
    ? (trackedBranches[normalizePath(leadProjectPath)] ?? null)
    : null;
  const membersWithLiveBranches = useMemo(() => {
    if (!data) return [];

    return members.map((member) => {
      const memberPath = member.cwd?.trim();
      const nextGitBranch =
        memberPath && !isLeadMember(member) && leadBranch !== null
          ? (() => {
              const branch = trackedBranches[normalizePath(memberPath)] ?? null;
              return branch && branch !== leadBranch ? branch : undefined;
            })()
          : undefined;

      if (member.gitBranch === nextGitBranch) {
        return member;
      }

      const nextMember: ResolvedTeamMember = { ...member };
      if (nextGitBranch) {
        nextMember.gitBranch = nextGitBranch;
      } else {
        delete nextMember.gitBranch;
      }
      return nextMember;
    });
  }, [data, leadBranch, members, trackedBranches]);
  const activeMembers = useStableActiveMembers(membersWithLiveBranches);
  const capabilityMember = useMemo(
    () =>
      membersWithLiveBranches.find((member) => isLeadMember(member)) ??
      membersWithLiveBranches[0] ??
      null,
    [membersWithLiveBranches]
  );

  const activeTeammateCount = useMemo(
    () => activeMembers.filter((m) => !isLeadMember(m)).length,
    [activeMembers]
  );

  const taskMap = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);
  const memberTaskCounts = useMemo(() => buildTaskCountsByOwner(data?.tasks ?? []), [data?.tasks]);
  const taskMapRef = useRef(taskMap);
  taskMapRef.current = taskMap;

  const handleRestartMember = useCallback(
    async (memberName: string): Promise<void> => {
      await restartMember(teamName, memberName);
    },
    [restartMember, teamName]
  );

  const handleSkipMemberForLaunch = useCallback(
    async (memberName: string): Promise<void> => {
      await skipMemberForLaunch(teamName, memberName);
    },
    [skipMemberForLaunch, teamName]
  );

  const handleSelectMember = useCallback((member: ResolvedTeamMember) => {
    setSelectedMember(member);
  }, []);

  const closeSelectedMemberDialog = useCallback(() => {
    setSelectedMember(null);
  }, []);

  const handleAssignTask = useCallback((member: ResolvedTeamMember) => {
    setTaskAssignee(member);
  }, []);

  const handleCreateTask = useCallback(
    async (
      subject: string,
      description: string,
      owner?: string,
      blockedBy?: string[],
      related?: string[],
      prompt?: string,
      startImmediately?: boolean,
      descriptionTaskRefs?: TaskRef[],
      promptTaskRefs?: TaskRef[]
    ): Promise<void> => {
      setCreatingTask(true);
      try {
        await createTeamTask(teamName, {
          subject,
          description: description || undefined,
          descriptionTaskRefs,
          owner,
          blockedBy,
          related,
          prompt,
          promptTaskRefs,
          startImmediately,
        });
        setTaskAssignee(null);
      } finally {
        setCreatingTask(false);
      }
    },
    [createTeamTask, teamName]
  );

  const handleSendMessageToMember = useCallback((member: ResolvedTeamMember) => {
    setTuningMember(member);
  }, []);

  const handleTaskIdClick = useCallback(
    (taskId: string) => {
      const task =
        taskMap.get(taskId) ?? data?.tasks.find((candidate) => candidate.displayId === taskId);
      if (task) {
        setReviewDialogState({
          open: true,
          mode: 'task',
          taskId: task.id,
          taskChangeRequestOptions: buildTaskChangeRequestOptions(task),
        });
      }
    },
    [taskMap, data?.tasks]
  );

  const handleEditorAction = useCallback(
    (action: EditorSelectionAction) => {
      if (action.type !== 'sendMessage') return;
      const lead = activeMembers.find((member) => isLeadMember(member)) ?? activeMembers[0];
      if (!lead) return;
      setPendingInboxThreadIntent({
        teamName,
        memberName: lead.name,
        compose: true,
        initialText: action.formattedContext,
      });
      openTasksTab();
    },
    [activeMembers, openTasksTab, setPendingInboxThreadIntent, teamName]
  );

  // Pick up pending review request from GlobalTaskDetailDialog
  useEffect(() => {
    if (!pendingReviewRequest) return;
    setReviewDialogState({
      open: true,
      mode: 'task',
      taskId: pendingReviewRequest.taskId,
      initialFilePath: pendingReviewRequest.filePath,
      taskChangeRequestOptions: pendingReviewRequest.requestOptions,
    });
    if (pendingReviewRequest.filePath) {
      selectReviewFile(pendingReviewRequest.filePath);
    }
    setPendingReviewRequest(null);
  }, [pendingReviewRequest, selectReviewFile, setPendingReviewRequest]);

  // Pick up pending member profile request from MemberHoverCard
  const pendingMemberProfile = useStore((s) => s.pendingMemberProfile);
  useEffect(() => {
    if (!pendingMemberProfile || !data) return;
    const member = membersWithLiveBranches.find((m) => m.name === pendingMemberProfile);
    if (member) {
      setSelectedMember(member);
    }
    useStore.getState().closeMemberProfile();
  }, [data, pendingMemberProfile, membersWithLiveBranches]);

  const handleDeleteTeam = useCallback((): void => {
    setDeleteConfirmOpen(true);
  }, []);

  const confirmDeleteTeam = useCallback((): void => {
    setDeleting(true);
    void (async () => {
      try {
        await deleteTeam(teamName);
        await fetchTeams();
        setDeleteConfirmOpen(false);
        if (tabId) closeTab(tabId);
        openTeamsTab();
      } catch (err) {
        console.error('Failed to delete team:', err);
        setDeleteConfirmOpen(false);
      } finally {
        setDeleting(false);
      }
    })();
  }, [teamName, deleteTeam, openTeamsTab, closeTab, tabId, fetchTeams]);

  if (!teamName) {
    return (
      <div className="flex size-full items-center justify-center p-6 text-sm text-red-400">
        Invalid team tab
      </div>
    );
  }

  const spawnStatusWatcher = (
    <TeamSpawnStatusWatcher
      teamName={teamName}
      isTeamProvisioning={isTeamProvisioning}
      isTeamAlive={data?.isAlive}
    />
  );
  const teamAgentRuntimeWatcher = (
    <TeamAgentRuntimeWatcher
      teamName={teamName}
      isTeamProvisioning={isTeamProvisioning}
      isTeamAlive={data?.isAlive}
      isThisTabActive={isThisTabActive}
    />
  );
  const leadContextWatcher = (
    <LeadContextWatcher
      teamName={teamName}
      tabId={tabId}
      projectId={projectId}
      leadSessionId={leadSessionId}
      sessionHistoryKey={sessionHistoryKey}
      isThisTabActive={isThisTabActive}
      isTeamAlive={data?.isAlive}
      sessions={sessions}
      sessionsLoading={sessionsLoading}
    />
  );

  const renderBody = (): React.JSX.Element => {
    if ((loading && !data) || (data && data.teamName !== teamName)) {
      return (
        <div className="size-full overflow-auto p-4">
          <div className="mb-4 h-10 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          <div ref={provisioningBannerRef}>
            <TeamProvisioningBanner teamName={teamName} />
          </div>
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
            <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
            <div className="h-48 animate-pulse rounded-md bg-[var(--color-surface-raised)]" />
          </div>
        </div>
      );
    }

    if (error === 'TEAM_DRAFT') {
      const draftTeamSummary = useStore.getState().teamByName[teamName];
      const draftDisplayName = draftTeamSummary?.displayName || teamName;
      const draftCwd = draftTeamSummary?.projectPath || draftTeamSummary?.workDir || '';
      const draftCommand = getCommandForHarness(draftTeamSummary?.harness);

      return (
        <div className="size-full overflow-auto p-6">
          <div ref={provisioningBannerRef}>
            <TeamProvisioningBanner teamName={teamName} />
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-medium text-text">{draftDisplayName}</p>
              <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-medium text-indigo-400">
                {draftCommand}
              </span>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-secondary)]">
              终端不再嵌入页面。需要接管这个工作区时，请在系统终端中打开默认 CLI。
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              disabled={!draftCwd}
              onClick={() => {
                if (!draftCwd) return;
                void api.terminal.openExternal({ command: draftCommand, cwd: draftCwd });
              }}
            >
              <Play size={13} />
              在系统终端打开
            </Button>
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex size-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm font-medium text-red-400">Agent 加载失败</p>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">{error}</p>
            <div className="mt-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void selectTeam(teamName, { allowReloadWhileProvisioning: true })}
              >
                重试加载
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (!data) {
      return (
        <div className="size-full overflow-auto p-4">
          <div ref={provisioningBannerRef}>
            <TeamProvisioningBanner teamName={teamName} />
          </div>
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-[var(--color-text-muted)]">
            创建完成后，这里将显示 Agent 数据
          </div>
        </div>
      );
    }

    // Prefer the store summary's displayName over data.config.name: for a draft or
    // partially-provisioned team (no team.json on disk) the server-side getData falls
    // back to the slug for config.name, but the user-facing name survives in teamByName.
    const displayTeamName = teamSummaryDisplayName || data.config.name || teamName;

    const headerColorSet = data.config.color
      ? getTeamColorSet(data.config.color)
      : nameColorSet(displayTeamName);
    const isExternallyReachable =
      data.isExternallyReachable ??
      data.platforms?.some((platform) => platform.type !== 'bridge' && platform.connected) === true;

    return (
      <>
        <div className="flex size-full overflow-hidden">
          <LeadContextBridge
            teamName={teamName}
            tabId={tabId}
            projectId={projectId}
            leadSessionId={leadSessionId}
            fallbackProjectRoot={data.config.projectPath}
          />

          <div className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={contentRef}
              className="mx-auto size-full min-w-0 max-w-[1400px] overflow-y-auto overflow-x-hidden p-4 md:p-5"
              data-team-name={teamName}
            >
              <div className="relative mb-5 border-b border-[var(--color-border)] pb-4">
                <div
                  className={cn(
                    'flex items-start justify-between gap-2',
                    headerColorSet && 'relative z-10'
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <img
                      src={teamAvatarUrl(teamName, displayTeamName)}
                      alt={displayTeamName}
                      className="size-8 shrink-0 rounded-md border border-transparent bg-[var(--color-surface-raised)]"
                      style={
                        headerColorSet ? { borderColor: headerColorSet.border + '60' } : undefined
                      }
                      draggable={false}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h1 className="text-lg font-semibold tracking-tight text-[var(--color-text)]">
                          {displayTeamName}
                        </h1>
                        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                          <span
                            className="size-1.5 rounded-full bg-emerald-400"
                            aria-hidden="true"
                          />
                          可用
                        </span>
                        {isExternallyReachable ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-500">
                            可对外
                          </span>
                        ) : null}
                        {isTeamProvisioning && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                            <span className="size-1.5 animate-pulse rounded-full bg-yellow-400" />
                            接入中...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {teamName !== SYSTEM_MANAGER_TEAM_NAME ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 px-2.5 text-xs text-[var(--color-text-secondary)]"
                        disabled={isTeamProvisioning}
                        onClick={() => setBindingDialogOpen(true)}
                      >
                        <Link size={12} />
                        运行时
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-xs text-[var(--color-text-secondary)]"
                      disabled={isTeamProvisioning}
                      onClick={() => setEditDialogOpen(true)}
                    >
                      <Pencil size={12} />
                      编辑
                    </Button>
                    <Popover open={headerMenuOpen} onOpenChange={setHeaderMenuOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-7 px-0 text-[var(--color-text-muted)]"
                          aria-label="更多 Agent 操作"
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-44 p-1">
                        {teamName !== 'default' &&
                          teamName !== 'my-project' &&
                          teamName !== SYSTEM_MANAGER_TEAM_NAME && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                              onClick={() => {
                                setHeaderMenuOpen(false);
                                handleDeleteTeam();
                              }}
                            >
                              <Trash2 size={13} />
                              删除团队
                            </button>
                          )}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                {data.config.description && (
                  <p
                    className={cn(
                      'min-w-0 truncate text-xs text-[var(--color-text-muted)]',
                      headerColorSet && 'relative z-10'
                    )}
                  >
                    {data.config.description}
                  </p>
                )}
                <div
                  className={cn(
                    'mt-1 flex items-start justify-between gap-3',
                    headerColorSet && 'relative z-10'
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
                    {data.teamName && (
                      <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
                        <FolderOpen size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="max-w-60 truncate font-mono">@{data.teamName}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <span className="font-mono text-xs">
                              {data.config.projectPath
                                ? formatProjectPath(data.config.projectPath)
                                : data.teamName}
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    )}
                    {leadBranch && (
                      <span
                        className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]"
                        title={leadBranch}
                      >
                        <GitBranch size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                        <span className="max-w-32 truncate">{leadBranch}</span>
                      </span>
                    )}
                  </div>
                </div>
                {(() => {
                  const currentPath = data.config.projectPath;
                  const history = data.config.projectPathHistory?.filter((p) => p !== currentPath);
                  if (!history || history.length === 0) return null;
                  return (
                    <div
                      className={cn(
                        'mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]',
                        headerColorSet && 'relative z-10'
                      )}
                    >
                      <History size={10} className="shrink-0" />
                      <span className="truncate">
                        历史路径：{history.map((p) => formatProjectPath(p)).join(', ')}
                      </span>
                    </div>
                  );
                })()}
              </div>

              <div ref={provisioningBannerRef}>
                <TeamProvisioningBanner teamName={teamName} />
              </div>

              {data.warnings?.some((warning) => warning.toLowerCase().includes('kanban')) ? (
                <div className="mb-3 rounded-md border border-[var(--step-warning-border)] bg-[var(--step-warning-bg)] px-3 py-2 text-xs text-[var(--step-warning-text)]">
                  看板未完整加载，当前展示的是安全回退数据。
                </div>
              ) : null}
              {reviewActionError ? (
                <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-[var(--step-error-text)]">
                  {reviewActionError}
                </div>
              ) : null}

              <CollapsibleTeamSection
                sectionId="team"
                title="Agent"
                icon={<Users size={14} />}
                badge={activeTeammateCount === 0 ? '单人' : activeTeammateCount}
                defaultOpen
              >
                <TeamMemberListBridge
                  teamName={teamName}
                  members={membersWithLiveBranches}
                  memberTaskCounts={memberTaskCounts}
                  taskMap={taskMap}
                  pendingRepliesByMember={pendingRepliesByMember}
                  isTeamAlive
                  isTeamProvisioning={isTeamProvisioning}
                  launchParams={launchParams}
                  onMemberClick={handleSelectMember}
                  onSendMessage={handleSendMessageToMember}
                  onAssignTask={handleAssignTask}
                  onOpenTask={handleTaskIdClick}
                  onRestartMember={handleRestartMember}
                  onSkipMemberForLaunch={handleSkipMemberForLaunch}
                />
              </CollapsibleTeamSection>

              {capabilityMember ? (
                <CollapsibleTeamSection
                  sectionId="capabilities"
                  title="Skills 与 MCP"
                  icon={<Sparkles size={14} />}
                  badge={capabilityMember.name}
                  defaultOpen
                >
                  <MemberCapabilitiesSummary open member={capabilityMember} teamName={teamName} />
                </CollapsibleTeamSection>
              ) : null}

              <CollapsibleTeamSection
                sectionId="assets"
                title="产物库"
                icon={<LibraryBig size={14} />}
                defaultOpen={false}
              >
                <TeamAssetsSection teamName={teamName} />
              </CollapsibleTeamSection>

              <ReviewDialog
                open={requestChangesTaskId !== null}
                teamName={teamName}
                taskId={requestChangesTaskId}
                members={members}
                onCancel={() => setRequestChangesTaskId(null)}
                onSubmit={(comment, taskRefs) => {
                  if (!requestChangesTaskId) {
                    return;
                  }
                  void (async () => {
                    try {
                      await updateKanban(teamName, requestChangesTaskId, {
                        op: 'request_changes',
                        comment,
                        taskRefs,
                      });
                      setRequestChangesTaskId(null);
                    } catch {
                      // error state is handled in the store and shown in the view
                    }
                  })();
                }}
              />

              <CreateTaskDialog
                key={taskAssignee?.name ?? 'closed'}
                open={taskAssignee !== null}
                teamName={teamName}
                members={membersWithLiveBranches}
                tasks={data.tasks}
                isTeamAlive
                defaultOwner={taskAssignee?.name ?? ''}
                onClose={() => setTaskAssignee(null)}
                onSubmit={(...args) => {
                  void handleCreateTask(...args).catch((createError: unknown) => {
                    console.error('Failed to create task from member roster:', createError);
                  });
                }}
                submitting={creatingTask}
              />

              <TeamMemberDetailDialogBridge
                open={selectedMember !== null}
                member={selectedMember}
                teamName={teamName}
                members={membersWithLiveBranches}
                tasks={data.tasks}
                isTeamAlive
                isTeamProvisioning={isTeamProvisioning}
                launchParams={launchParams}
                onClose={closeSelectedMemberDialog}
                onSendMessage={() => {
                  if (!selectedMember) return;
                  setTuningMember(selectedMember);
                  closeSelectedMemberDialog();
                }}
                onAssignTask={() => {
                  if (!selectedMember) return;
                  const member = selectedMember;
                  closeSelectedMemberDialog();
                  handleAssignTask(member);
                }}
                onTaskClick={(task) => {
                  closeSelectedMemberDialog();
                  handleTaskIdClick(task.id);
                }}
                onRestartMember={handleRestartMember}
                onUpdateRole={async (memberName, role) => {
                  setUpdatingRoleLoading(true);
                  try {
                    await updateMemberRole(teamName, memberName, role);
                    // Optimistically update local selectedMember to reflect new role
                    setSelectedMember((prev) => {
                      if (prev?.name !== memberName) return prev;
                      const normalized =
                        typeof role === 'string' && role.trim() ? role.trim() : undefined;
                      return { ...prev, role: normalized };
                    });
                  } finally {
                    setUpdatingRoleLoading(false);
                  }
                }}
                updatingRole={updatingRoleLoading}
                onRemoveMember={() => {
                  const name = selectedMember?.name;
                  if (!name) return;
                  setRemoveMemberConfirm(name);
                }}
                onViewMemberChanges={(memberName, filePath) => {
                  closeSelectedMemberDialog();
                  setReviewDialogState({
                    open: true,
                    mode: 'agent',
                    memberName,
                    initialFilePath: filePath,
                  });
                }}
              />

              {tuningMember ? (
                <AgentTuningDialog
                  open
                  teamName={teamName}
                  member={tuningMember}
                  onClose={() => setTuningMember(null)}
                />
              ) : null}

              <Dialog
                open={removeMemberConfirm !== null}
                onOpenChange={(open) => {
                  if (!open) setRemoveMemberConfirm(null);
                }}
              >
                <DialogContent className="max-w-sm">
                  <DialogHeader>
                    <DialogTitle>移除成员</DialogTitle>
                    <DialogDescription>
                      确认将 &ldquo;{removeMemberConfirm}&rdquo; 从团队中移除？任务与 动态会保留，
                      但该名称将无法再次使用。
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => setRemoveMemberConfirm(null)}>
                      取消
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        const name = removeMemberConfirm;
                        setRemoveMemberConfirm(null);
                        closeSelectedMemberDialog();
                        if (name) void removeMember(teamName, name);
                      }}
                    >
                      移除
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog
                open={deleteConfirmOpen}
                onOpenChange={(v) => {
                  if (!deleting) setDeleteConfirmOpen(v);
                }}
              >
                <DialogContent className="max-w-sm">
                  <DialogHeader>
                    <DialogTitle>删除 Agent</DialogTitle>
                    <DialogDescription>
                      确认删除 Agent &ldquo;{displayTeamName}
                      &rdquo;？此操作不可恢复，相关配置与任务数据都将被删除。
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
                      取消
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={confirmDeleteTeam}
                      disabled={deleting}
                    >
                      {deleting && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                      删除并重启
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <ChangeReviewDialog
                open={reviewDialogState.open}
                onOpenChange={(open) =>
                  setReviewDialogState((prev) => ({
                    ...prev,
                    open,
                    ...(open
                      ? {}
                      : { initialFilePath: undefined, taskChangeRequestOptions: undefined }),
                  }))
                }
                teamName={teamName}
                mode={reviewDialogState.mode}
                memberName={reviewDialogState.memberName}
                taskId={reviewDialogState.taskId}
                initialFilePath={reviewDialogState.initialFilePath}
                taskChangeRequestOptions={reviewDialogState.taskChangeRequestOptions}
                projectPath={data.config.projectPath}
                onEditorAction={handleEditorAction}
              />
            </div>
          </div>
        </div>

        {editorOpen && data.config.projectPath && (
          <Suspense fallback={null}>
            <ProjectEditorOverlay
              projectPath={data.config.projectPath}
              onClose={() => setEditorOpen(false)}
              onEditorAction={handleEditorAction}
            />
          </Suspense>
        )}
      </>
    );
  };

  return (
    <>
      {spawnStatusWatcher}
      {teamAgentRuntimeWatcher}
      {leadContextWatcher}
      <div className="flex size-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{renderBody()}</div>
      </div>
      {data && teamName !== SYSTEM_MANAGER_TEAM_NAME ? (
        <RuntimeConfigDialog
          open={bindingDialogOpen}
          teamName={teamName}
          onClose={() => setBindingDialogOpen(false)}
        />
      ) : null}
      <EditTeamDialog
        open={editDialogOpen}
        teamName={teamName}
        onClose={() => setEditDialogOpen(false)}
      />
    </>
  );
};

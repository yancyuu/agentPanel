import { useCallback, useEffect, useMemo, useState } from 'react';

import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { selectTeamMessages, TEAM_MESSAGES_PAGE_LIMIT } from '@renderer/store/slices/teamSlice';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import {
  Bot,
  FilePen,
  FileText,
  Globe,
  type LucideIcon,
  Search,
  SquareTerminal,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  type TimelineItem,
} from '../activity/LeadThoughtsGroup';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';
import { StatusBlock } from '../messages/StatusBlock';

import { LoopCommandComposer } from './LoopCommandComposer';
import { useLeadSessionToolActivity } from './useLeadSessionToolActivity';
import { useLoopConsoleController } from './useLoopConsoleController';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { LeadToolActivity } from '@renderer/utils/leadToolActivity';
import type {
  CcSession,
  InboxMessage,
  ResolvedTeamMember,
  TeamTaskWithKanban,
} from '@shared/types';

interface LoopConsolePanelProps {
  teamName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  isTeamAlive?: boolean;
  isProvisioning?: boolean;
  leadActivity?: string;
  leadContextUpdatedAt?: string;
  currentLeadSessionId?: string;
  /** Workspace path owning the lead session — used to fetch its tool activity. */
  leadProjectPath?: string | null;
  sessions?: CcSession[];
  commandSuggestions?: MentionSuggestion[];
  slashCommandMode?: 'message' | 'session';
  pendingRepliesByMember: Record<string, number>;
  onPendingReplyChange: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  onRestartTeam?: () => void;
  onTaskIdClick?: (taskId: string) => void;
  statusLabel?: string;
  sessionPendingRecipient?: string;
}

function reconcilePendingRepliesByMember(
  pendingRepliesByMember: Record<string, number>,
  messages: InboxMessage[]
): Record<string, number> {
  if (Object.keys(pendingRepliesByMember).length === 0) return pendingRepliesByMember;

  const latestReplyToUserByMember = new Map<string, number>();
  for (const message of messages) {
    if (message.to !== 'user') continue;
    const ts = Date.parse(message.timestamp);
    if (!Number.isFinite(ts)) continue;
    const previous = latestReplyToUserByMember.get(message.from);
    if (previous == null || ts > previous) latestReplyToUserByMember.set(message.from, ts);
  }

  let changed = false;
  const next: Record<string, number> = {};
  for (const [memberName, sentAtMs] of Object.entries(pendingRepliesByMember)) {
    const latestReplyAt = latestReplyToUserByMember.get(memberName);
    if (latestReplyAt != null && latestReplyAt > sentAtMs) {
      changed = true;
      continue;
    }
    next[memberName] = sentAtMs;
  }
  return changed ? next : pendingRepliesByMember;
}

export const LoopConsolePanel = ({
  teamName,
  members,
  tasks,
  isTeamAlive,
  isProvisioning,
  leadActivity,
  leadContextUpdatedAt,
  currentLeadSessionId,
  leadProjectPath,
  sessions = [],
  commandSuggestions,
  slashCommandMode = 'message',
  pendingRepliesByMember,
  onPendingReplyChange,
  onMemberClick,
  onTaskClick,
  onReplyToMessage,
  onRestartTeam,
  onTaskIdClick,
  statusLabel,
  sessionPendingRecipient,
}: LoopConsolePanelProps): React.JSX.Element => {
  const {
    teams,
    openTeamTab,
    messages,
    hasMore,
    loadingOlderMessages,
    headHydrated,
    loadOlderTeamMessages,
    refreshTeamMessagesHead,
    clearTeamMessages,
  } = useStore(
    useShallow((s) => ({
      teams: s.teams,
      openTeamTab: s.openTeamTab,
      messages: selectTeamMessages(s, teamName),
      hasMore: teamName ? (s.teamMessagesByName[teamName]?.hasMore ?? false) : false,
      loadingOlderMessages: teamName
        ? (s.teamMessagesByName[teamName]?.loadingOlder ?? false)
        : false,
      headHydrated: teamName ? (s.teamMessagesByName[teamName]?.headHydrated ?? false) : false,
      loadOlderTeamMessages: s.loadOlderTeamMessages,
      refreshTeamMessagesHead: s.refreshTeamMessagesHead,
      clearTeamMessages: s.clearTeamMessages,
    }))
  );
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);

  const teamSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [sessions]
  );
  const selectedSessionKey = teamSessions[0]?.sessionKey ?? null;

  useEffect(() => {
    // Only auto-hydrate the head when we genuinely haven't loaded yet.
    // After a manual clear the view is intentionally empty (clearedAt cutoff hides
    // older messages), so we must NOT refetch — otherwise the server re-pushes the
    // same messages and the empty view refights itself.
    if (messages.length > 0 || headHydrated) return;
    void refreshTeamMessagesHead(teamName).catch(() => undefined);
  }, [messages.length, headHydrated, refreshTeamMessagesHead, teamName]);

  const activityMessages = useMemo(
    () => [...messages].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    [messages]
  );

  // Tool calls (Bash/Read/Edit/…) live in the parsed lead session, not the message
  // feed. Surface the most recent ones as a compact activity strip so the console
  // shows what the lead agent actually did, alongside the message timeline.
  const toolActivity = useLeadSessionToolActivity({
    teamName,
    sessionId: currentLeadSessionId,
    projectPath: leadProjectPath,
    isAlive: isTeamAlive,
  });

  const { readSet, markRead } = useTeamMessagesRead(teamName);
  const { expandedSet, toggle: toggleExpandOverride } = useTeamMessagesExpanded(teamName);
  const readState = useMemo(() => ({ readSet, getMessageKey: toMessageKey }), [readSet]);
  const { teamNames, teamColorByName } = useStableTeamMentionMeta(teams);

  const expandedItem = useMemo<TimelineItem | null>(() => {
    if (!expandedItemKey) return null;
    if (!expandedItemKey.startsWith('thoughts-')) {
      const msg = activityMessages.find((message) => toMessageKey(message) === expandedItemKey);
      return msg ? { type: 'message', message: msg } : null;
    }
    const allItems = groupTimelineItems(activityMessages);
    return (
      allItems.find(
        (item) =>
          item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === expandedItemKey
      ) ?? null
    );
  }, [activityMessages, expandedItemKey]);

  useEffect(() => {
    if (expandedItemKey && expandedItem === null) setExpandedItemKey(null);
  }, [expandedItem, expandedItemKey]);

  const { sending, statusMessage, submitIntent } = useLoopConsoleController({
    teamName,
    sessionKey: selectedSessionKey,
    sessionPendingRecipient,
    onPendingReplyChange,
  });

  useEffect(() => {
    if (Object.keys(pendingRepliesByMember).length === 0) return;
    const next = reconcilePendingRepliesByMember(pendingRepliesByMember, activityMessages);
    if (next !== pendingRepliesByMember) onPendingReplyChange(() => next);
  }, [activityMessages, onPendingReplyChange, pendingRepliesByMember]);

  const handleMessageVisible = useCallback(
    (message: InboxMessage) => {
      markRead(toMessageKey(message));
    },
    [markRead]
  );

  const loadOlderMessages = useCallback(async () => {
    const entry = useStore.getState().teamMessagesByName[teamName];
    if (!entry?.hasMore || entry.loadingHead || entry.loadingOlder) return;
    await loadOlderTeamMessages(teamName);
  }, [loadOlderTeamMessages, teamName]);

  const handleClear = useCallback(() => {
    if (activityMessages.length === 0) return;
    void confirm({
      title: '清空指令台消息',
      message: `确定清空当前显示的 ${activityMessages.length} 条消息？旧消息会在本机持续隐藏，服务端历史记录仍会保留。`,
      confirmLabel: '清空',
      variant: 'danger',
    }).then((confirmed) => {
      if (confirmed) clearTeamMessages(teamName);
    });
  }, [activityMessages.length, clearTeamMessages, teamName]);

  return (
    <div className="space-y-3 rounded-xl border border-indigo-500/15 bg-[var(--color-surface)] p-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal size={14} className="shrink-0 text-indigo-300" />
          <div className="truncate text-xs font-medium text-[var(--color-text)]">指令台</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            {statusLabel ?? (isTeamAlive ? '在线' : '离线')}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={activityMessages.length === 0}
            onClick={handleClear}
            title="清空当前显示的消息"
          >
            <Trash2 size={11} />
            清空
          </button>
        </div>
      </div>

      <LoopCommandComposer
        teamName={teamName}
        members={members}
        isTeamAlive={isTeamAlive}
        isProvisioning={isProvisioning}
        sending={sending}
        commandSuggestions={commandSuggestions}
        slashCommandMode={slashCommandMode}
        projectPath={leadProjectPath}
        onSubmit={submitIntent}
      />
      {statusMessage ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          {statusMessage}
        </div>
      ) : null}
      {toolActivity.length > 0 ? <LeadToolActivityStrip activities={toolActivity} /> : null}
      <StatusBlock
        members={members}
        tasks={tasks}
        messages={activityMessages}
        pendingRepliesByMember={pendingRepliesByMember}
        layout="flow"
        position="inline"
        onMemberClick={onMemberClick}
        onTaskClick={onTaskClick}
      />
      <ActivityTimeline
        messages={activityMessages}
        teamName={teamName}
        members={members}
        readState={readState}
        expandOverrides={expandedSet}
        onToggleExpandOverride={toggleExpandOverride}
        currentLeadSessionId={currentLeadSessionId}
        isTeamAlive={isTeamAlive}
        leadActivity={leadActivity}
        leadContextUpdatedAt={leadContextUpdatedAt}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={openTeamTab}
        onMemberClick={onMemberClick}
        onReplyToMessage={onReplyToMessage}
        onMessageVisible={handleMessageVisible}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
        onExpandItem={setExpandedItemKey}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
        <span>
          消息分页：当前显示 {activityMessages.length} 条；首次只取最近 {TEAM_MESSAGES_PAGE_LIMIT}{' '}
          条，每次再加载 {TEAM_MESSAGES_PAGE_LIMIT} 条，不会一次性渲染全部历史。
        </span>
        {hasMore ? (
          <button
            type="button"
            className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-50"
            disabled={loadingOlderMessages}
            onClick={() => void loadOlderMessages()}
          >
            {loadingOlderMessages ? '加载中...' : `加载更早 ${TEAM_MESSAGES_PAGE_LIMIT} 条`}
          </button>
        ) : (
          <span className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[10px]">
            已到当前分页末尾
          </span>
        )}
      </div>
      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItemKey !== null}
        onOpenChange={(open) => {
          if (!open) setExpandedItemKey(null);
        }}
        teamName={teamName}
        members={members}
        onReplyToMessage={onReplyToMessage}
        onMemberClick={onMemberClick}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={openTeamTab}
      />
    </div>
  );
};

function toolIcon(name: string): LucideIcon {
  switch (name) {
    case 'Bash':
      return Terminal;
    case 'Read':
    case 'Write':
      return FileText;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return FilePen;
    case 'Grep':
    case 'Glob':
      return Search;
    case 'Task':
    case 'Agent':
      return Bot;
    case 'WebFetch':
    case 'WebSearch':
      return Globe;
    default:
      return Wrench;
  }
}

/**
 * Compact horizontal strip of the lead agent's most recent tool calls.
 * Newest first; horizontally scrollable so a burst of activity never overflows
 * the console layout.
 */
const LeadToolActivityStrip = ({ activities }: { activities: readonly LeadToolActivity[] }) => {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5">
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-[var(--color-text-muted)]">
        <Wrench size={11} />
        工具活动
      </span>
      {activities.map((activity, index) => {
        const Icon = toolIcon(activity.name);
        return (
          <span
            key={activity.toolUseId ?? `${activity.name}-${index}`}
            className="inline-flex max-w-[240px] shrink-0 items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px]"
            title={activity.preview ? `${activity.name} · ${activity.preview}` : activity.name}
          >
            <Icon size={10} className="shrink-0 text-indigo-300" />
            <span className="shrink-0 font-medium text-[var(--color-text)]">{activity.name}</span>
            {activity.preview ? (
              <span className="truncate text-[var(--color-text-muted)]">{activity.preview}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
};

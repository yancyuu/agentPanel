import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Sheet, type SheetRef } from 'react-modal-sheet';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { selectTeamMessages } from '@renderer/store/slices/teamSlice';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { shouldExcludeInboxTextFromReplyCandidates } from '@shared/utils/idleNotificationSemantics';
import {
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquare,
  PanelBottom,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeft,
  PanelLeftClose,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityTimeline, type TimelineViewport } from '../activity/ActivityTimeline';
import { getThoughtGroupKey, groupTimelineItems } from '../activity/LeadThoughtsGroup';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';
import { CollapsibleTeamSection } from '../CollapsibleTeamSection';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '../sidebar/teamSidebarUiState';

import { MessageComposer } from './MessageComposer';
import { MessagesFilterPopover } from './MessagesFilterPopover';
import { StatusBlock } from './StatusBlock';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { MessagesFilterState } from './MessagesFilterPopover';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type {
  AgentActionMode,
  CcSession,
  InboxMessage,
  ResolvedTeamMember,
  SlashCommandMeta,
  TaskRef,
  TeamTaskWithKanban,
} from '@shared/types';

interface TimeWindow {
  start: number;
  end: number;
}

const BOTTOM_SHEET_HEADER_HEIGHT = 40;
const BOTTOM_SHEET_COLLAPSED_SNAP_INDEX = 1;
const BOTTOM_SHEET_COMPOSER_SNAP_INDEX = 2;
const BOTTOM_SHEET_FULL_SNAP_INDEX = 4;
const AUTO_LOAD_OLDER_SCROLL_TOP_PX = 56;

interface MessagesPanelProps {
  teamName: string;
  position: TeamMessagesPanelMode;
  onPositionChange: (position: TeamMessagesPanelMode) => void;
  mountPoint?: Element | null;
  /** Active (non-removed) members. */
  members: ResolvedTeamMember[];
  /** All team tasks. */
  tasks: TeamTaskWithKanban[];
  /** Whether the team is alive. */
  isTeamAlive?: boolean;
  /** Live lead activity status for the current team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the current team. */
  leadContextUpdatedAt?: string;
  /** Time window for filtering. */
  timeWindow: TimeWindow | null;
  /** Current lead session ID. */
  currentLeadSessionId?: string;
  /** cc-connect sessions owned by the parent team detail view. */
  sessions?: CcSession[];
  /** Pending replies tracker (shared with parent for MemberList). */
  pendingRepliesByMember: Record<string, number>;
  /** Update pending replies tracker. */
  onPendingReplyChange: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  /** Callback when a member is clicked in the timeline. */
  onMemberClick?: (member: ResolvedTeamMember) => void;
  /** Callback when a task is clicked from timeline or status block. */
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  /** Callback to open create task dialog from a message. */
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  /** Callback to open reply dialog for a message. */
  onReplyToMessage?: (message: InboxMessage) => void;
  /** Callback when "Restart team" is clicked. */
  onRestartTeam?: () => void;
  /** Callback when a task ID link is clicked. */
  onTaskIdClick?: (taskId: string) => void;
  /**
   * Scroll container owned by the parent view when `position === 'inline'`.
   * MessagesPanel does not own this element — the viewport lives in
   * TeamDetailView's content scroll area. Plumbed for future viewport
   * consumers (virtualization); unused in this release.
   */
  inlineScrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Hide layout-switch controls when the parent owns placement. */
  showPositionControls?: boolean;
  /** Override the inline section title when embedded in a parent surface. */
  sectionTitle?: string;
}

export function reconcilePendingRepliesByMember(
  pendingRepliesByMember: Record<string, number>,
  messages: InboxMessage[]
): Record<string, number> {
  if (Object.keys(pendingRepliesByMember).length === 0) {
    return pendingRepliesByMember;
  }

  const latestUserSentByMember = new Map<string, number>();
  const latestReplyToUserByMember = new Map<string, number>();

  for (const message of messages) {
    const ts = Date.parse(message.timestamp);
    if (!Number.isFinite(ts)) {
      continue;
    }

    if (
      message.from === 'user' &&
      typeof message.to === 'string' &&
      message.to.length > 0 &&
      message.source === 'user_sent'
    ) {
      const previous = latestUserSentByMember.get(message.to);
      if (previous == null || ts > previous) {
        latestUserSentByMember.set(message.to, ts);
      }
      continue;
    }

    if (message.to === 'user') {
      const previous = latestReplyToUserByMember.get(message.from);
      if (previous == null || ts > previous) {
        latestReplyToUserByMember.set(message.from, ts);
      }
    }
  }

  let changed = false;
  const next: Record<string, number> = {};
  for (const [memberName, sentAtMs] of Object.entries(pendingRepliesByMember)) {
    const latestReplyAt = latestReplyToUserByMember.get(memberName);
    const latestDurableSendAt = latestUserSentByMember.get(memberName);
    const threshold = latestDurableSendAt ?? sentAtMs;
    if (latestReplyAt != null && latestReplyAt > threshold) {
      changed = true;
      continue;
    }
    next[memberName] = sentAtMs;
  }

  return changed ? next : pendingRepliesByMember;
}

export const MessagesPanel = memo(function MessagesPanel({
  teamName,
  position,
  onPositionChange,
  mountPoint,
  members,
  tasks,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  timeWindow,
  currentLeadSessionId,
  sessions = [],
  pendingRepliesByMember,
  onPendingReplyChange,
  onMemberClick,
  onTaskClick,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onRestartTeam,
  onTaskIdClick,
  inlineScrollContainerRef,
  showPositionControls = true,
  sectionTitle,
}: MessagesPanelProps): React.JSX.Element {
  const {
    sendTeamMessage,
    sendingMessage,
    sendMessageError,
    sendMessageWarning,
    sendMessageDebugDetails,
    lastSendMessageResult,
    teams,
    openTeamTab,
    messages,
    hasMore,
    loadingOlderMessages,
    loadOlderTeamMessages,
    refreshTeamMessagesHead,
  } = useStore(
    useShallow((s) => ({
      sendTeamMessage: s.sendTeamMessage,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      sendMessageWarning: s.sendMessageWarning,
      sendMessageDebugDetails: s.sendMessageDebugDetails,
      lastSendMessageResult: s.lastSendMessageResult,
      teams: s.teams,
      openTeamTab: s.openTeamTab,
      messages: selectTeamMessages(s, teamName),
      // Subscribe to only the primitive flags the panel renders. The full
      // cache entry object is rebuilt on every (even no-op) head refresh —
      // selecting it wholesale would re-render this heavy panel every poll.
      hasMore: teamName ? (s.teamMessagesByName[teamName]?.hasMore ?? false) : false,
      loadingOlderMessages: teamName
        ? (s.teamMessagesByName[teamName]?.loadingOlder ?? false)
        : false,
      loadOlderTeamMessages: s.loadOlderTeamMessages,
      refreshTeamMessagesHead: s.refreshTeamMessagesHead,
    }))
  );
  const bootstrapHeadRefreshAttemptedForTeamRef = useRef<string | null>(null);

  const loadOlderMessages = useCallback(async () => {
    // Read the live cache entry instead of subscribing to it — loadingHead
    // toggles on every background head refresh and must not re-render us.
    const entry = useStore.getState().teamMessagesByName[teamName];
    if (!entry?.hasMore || entry.loadingHead || entry.loadingOlder) {
      return;
    }
    await loadOlderTeamMessages(teamName);
  }, [loadOlderTeamMessages, teamName]);

  const effectiveMessages = messages;
  const loadedMessageCount = effectiveMessages.length;
  const autoLoadOlderLockRef = useRef(false);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomSheetRef = useRef<SheetRef>(null);
  const bottomSheetStickyTopRef = useRef<HTMLDivElement | null>(null);
  // Scroll container inside `Sheet.Content` for the bottom-sheet layout.
  // react-modal-sheet merges this ref with its own internal scroll ref.
  // Held here so future viewport consumers (virtualization) can observe the
  // true scrolling element in bottom-sheet mode.
  const bottomSheetScrollRef = useRef<HTMLDivElement | null>(null);

  // Resolve the active scroll owner for the current layout. This is the
  // ref that ActivityTimeline's IntersectionObserver will use as its root,
  // so visibility is measured against the real scroll container rather
  // than the document viewport. Virtualizer consumers will hook into the
  // same ref in a follow-up change.
  const activeScrollContainerRef =
    position === 'inline'
      ? (inlineScrollContainerRef ?? null)
      : position === 'sidebar'
        ? sidebarScrollRef
        : bottomSheetScrollRef;

  const maybeAutoLoadOlderMessages = useCallback(
    (scrollTop: number) => {
      if (scrollTop > AUTO_LOAD_OLDER_SCROLL_TOP_PX || !hasMore || loadingOlderMessages) {
        return;
      }
      // loadingHead is read live (not subscribed) to avoid per-poll re-renders.
      if (useStore.getState().teamMessagesByName[teamName]?.loadingHead) {
        return;
      }
      if (autoLoadOlderLockRef.current) {
        return;
      }
      autoLoadOlderLockRef.current = true;
      void loadOlderMessages();
    },
    [hasMore, loadOlderMessages, loadingOlderMessages, teamName]
  );

  useEffect(() => {
    if (!loadingOlderMessages) {
      autoLoadOlderLockRef.current = false;
    }
  }, [loadingOlderMessages]);

  const activityTimelineViewport = useMemo<TimelineViewport | undefined>(() => {
    if (!activeScrollContainerRef) return undefined;
    return {
      scrollElementRef: activeScrollContainerRef,
      observerRoot: activeScrollContainerRef,
      scrollMargin: 0,
      // Opt into virtualization; ActivityTimeline keeps the direct render
      // path for short lists and only switches to the windowed path once
      // the row count crosses its internal threshold.
      virtualizationEnabled: true,
    };
  }, [activeScrollContainerRef]);
  const handleExpandContent = useCallback(() => {
    // no-op: user is reading expanded content, not composing
  }, []);

  const initialSidebarStateRef = useRef(getTeamMessagesSidebarUiState(teamName));
  const [messagesSearchQuery, setMessagesSearchQuery] = useState(
    initialSidebarStateRef.current.messagesSearchQuery
  );
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>(
    initialSidebarStateRef.current.messagesFilter
  );
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(
    initialSidebarStateRef.current.messagesFilterOpen
  );
  const [messagesCollapsed, setMessagesCollapsed] = useState(
    initialSidebarStateRef.current.messagesCollapsed
  );
  const [messagesSearchBarVisible, setMessagesSearchBarVisible] = useState(
    initialSidebarStateRef.current.messagesSearchBarVisible
  );
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(
    initialSidebarStateRef.current.expandedItemKey
  );
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [quickParticipantFilter, setQuickParticipantFilter] = useState<string | null>(null);
  const [messagesScrollTop, setMessagesScrollTop] = useState(
    initialSidebarStateRef.current.messagesScrollTop
  );
  const [bottomSheetSnapIndex, setBottomSheetSnapIndex] = useState(
    initialSidebarStateRef.current.bottomSheetSnapIndex
  );
  const [bottomSheetStickyTopHeight, setBottomSheetStickyTopHeight] = useState(196);
  const [bottomSheetMountHeight, setBottomSheetMountHeight] = useState(0);

  useEffect(() => {
    initialSidebarStateRef.current = getTeamMessagesSidebarUiState(teamName);
    setMessagesSearchQuery(initialSidebarStateRef.current.messagesSearchQuery);
    setMessagesFilter(initialSidebarStateRef.current.messagesFilter);
    setMessagesFilterOpen(initialSidebarStateRef.current.messagesFilterOpen);
    setMessagesCollapsed(initialSidebarStateRef.current.messagesCollapsed);
    setMessagesSearchBarVisible(initialSidebarStateRef.current.messagesSearchBarVisible);
    setExpandedItemKey(initialSidebarStateRef.current.expandedItemKey);
    setSelectedSessionKey(null);
    setQuickParticipantFilter(null);
    setMessagesScrollTop(initialSidebarStateRef.current.messagesScrollTop);
    setBottomSheetSnapIndex(initialSidebarStateRef.current.bottomSheetSnapIndex);
  }, [teamName]);

  const teamSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [sessions]
  );

  useEffect(() => {
    setSelectedSessionKey((current) =>
      current && teamSessions.some((session) => session.sessionKey === current) ? current : null
    );
  }, [teamSessions]);

  useEffect(() => {
    setTeamMessagesSidebarUiState(teamName, {
      messagesSearchQuery,
      messagesFilter,
      messagesFilterOpen,
      messagesCollapsed,
      messagesSearchBarVisible,
      expandedItemKey,
      messagesScrollTop,
      bottomSheetSnapIndex,
    });
  }, [
    teamName,
    messagesSearchQuery,
    messagesFilter,
    messagesFilterOpen,
    messagesCollapsed,
    messagesSearchBarVisible,
    expandedItemKey,
    messagesScrollTop,
    bottomSheetSnapIndex,
  ]);

  useEffect(() => {
    const hasActiveParticipantFilter = messagesFilter.from.size > 0 || messagesFilter.to.size > 0;
    if (
      messagesSearchBarVisible ||
      (messagesSearchQuery.trim().length === 0 && !hasActiveParticipantFilter)
    ) {
      return;
    }
    setMessagesSearchBarVisible(true);
  }, [messagesFilter.from, messagesFilter.to, messagesSearchBarVisible, messagesSearchQuery]);

  useEffect(() => {
    if (!teamName) {
      return;
    }
    if (effectiveMessages.length > 0) {
      bootstrapHeadRefreshAttemptedForTeamRef.current = null;
      return;
    }
    // Read loading flags live rather than subscribing — they toggle on every
    // background head refresh and must not drive this bootstrap effect.
    const entry = useStore.getState().teamMessagesByName[teamName];
    if (entry?.loadingHead || entry?.loadingOlder) {
      return;
    }
    if (bootstrapHeadRefreshAttemptedForTeamRef.current === teamName) {
      return;
    }
    bootstrapHeadRefreshAttemptedForTeamRef.current = teamName;
    void refreshTeamMessagesHead(teamName).catch(() => undefined);
  }, [effectiveMessages.length, refreshTeamMessagesHead, teamName]);

  useLayoutEffect(() => {
    if (position !== 'sidebar') return;
    const el = sidebarScrollRef.current;
    if (!el) return;
    el.scrollTop = messagesScrollTop;
  }, [position, messagesScrollTop]);

  useEffect(() => {
    if (position === 'sidebar') {
      return;
    }
    const scrollElement =
      position === 'bottom-sheet'
        ? bottomSheetScrollRef.current
        : (inlineScrollContainerRef?.current ?? null);
    if (!scrollElement) {
      return;
    }
    const onScroll = () => {
      maybeAutoLoadOlderMessages(scrollElement.scrollTop);
    };
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      scrollElement.removeEventListener('scroll', onScroll);
    };
  }, [inlineScrollContainerRef, maybeAutoLoadOlderMessages, position]);

  useLayoutEffect(() => {
    if (position !== 'bottom-sheet' || typeof ResizeObserver === 'undefined') return;

    const mountPointElement = mountPoint instanceof HTMLElement ? mountPoint : null;
    const observedEntries: [Element | null, (height: number) => void][] = [
      [bottomSheetStickyTopRef.current, setBottomSheetStickyTopHeight],
      [mountPointElement, setBottomSheetMountHeight],
    ];
    const observers: ResizeObserver[] = [];

    for (const [element, setHeight] of observedEntries) {
      if (!element) continue;

      const updateHeight = (): void => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (nextHeight > 0) {
          setHeight(nextHeight);
        }
      };

      updateHeight();

      const observer = new ResizeObserver(() => {
        updateHeight();
      });
      observer.observe(element);
      observers.push(observer);
    }

    return () => {
      observers.forEach((observer) => observer.disconnect());
    };
  }, [position, mountPoint]);

  const sessionScopedMessages = useMemo(() => {
    const newestFirst = (items: InboxMessage[]) =>
      [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    if (!selectedSessionKey) return newestFirst(effectiveMessages);
    return newestFirst(
      effectiveMessages.filter((message) => message.session?.key === selectedSessionKey)
    );
  }, [effectiveMessages, selectedSessionKey]);

  const participantOptions = useMemo(() => {
    const senderNames = new Set<string>();
    for (const message of sessionScopedMessages) {
      const sender = message.from?.trim();
      if (sender) senderNames.add(sender);
    }

    const seen = new Set<string>();
    const orderedSenders: string[] = [];
    const addSender = (value: string | null | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed || seen.has(trimmed) || !senderNames.has(trimmed)) return;
      seen.add(trimmed);
      orderedSenders.push(trimmed);
    };

    addSender('user');
    for (const member of members) addSender(member.name);
    for (const message of sessionScopedMessages) addSender(message.from);

    return orderedSenders.slice(0, 24);
  }, [members, sessionScopedMessages]);

  useEffect(() => {
    if (quickParticipantFilter && !participantOptions.includes(quickParticipantFilter)) {
      setQuickParticipantFilter(null);
    }
  }, [participantOptions, quickParticipantFilter]);

  const matchesParticipant = useCallback((message: InboxMessage, participant: string): boolean => {
    return message.from?.trim() === participant;
  }, []);

  const filteredMessages = useMemo(() => {
    const participantFiltered = quickParticipantFilter
      ? sessionScopedMessages.filter((message) =>
          matchesParticipant(message, quickParticipantFilter)
        )
      : sessionScopedMessages;
    return filterTeamMessages(participantFiltered, {
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [
    matchesParticipant,
    messagesFilter,
    messagesSearchQuery,
    quickParticipantFilter,
    sessionScopedMessages,
    timeWindow,
  ]);

  const setParticipantFilter = useCallback((name: string | null) => {
    setQuickParticipantFilter(name);
  }, []);

  const participantFilterBar = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px]">
      <button
        type="button"
        className={cn(
          'shrink-0 rounded-full border px-2 py-0.5 transition-colors',
          quickParticipantFilter === null
            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-500'
            : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
        )}
        onClick={() => setParticipantFilter(null)}
      >
        全部成员
      </button>
      {participantOptions.map((participant) => (
        <button
          key={participant}
          type="button"
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 transition-colors',
            quickParticipantFilter === participant
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-500'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          )}
          onClick={() =>
            setParticipantFilter(quickParticipantFilter === participant ? null : participant)
          }
        >
          <MemberBadge
            name={participant === 'user' ? '用户' : participant}
            size="sm"
            hideAvatar
            disableHoverCard
          />
        </button>
      ))}
    </div>
  );

  const activityTimelineMessages = useMemo(() => {
    const participantFiltered = quickParticipantFilter
      ? sessionScopedMessages.filter((message) =>
          matchesParticipant(message, quickParticipantFilter)
        )
      : sessionScopedMessages;
    return filterTeamMessages(participantFiltered, {
      includePassiveIdlePeerSummariesWhenNoiseHidden: true,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [
    matchesParticipant,
    messagesFilter,
    messagesSearchQuery,
    quickParticipantFilter,
    sessionScopedMessages,
    timeWindow,
  ]);

  const replyCandidateMessages = useMemo(
    () =>
      effectiveMessages.filter(
        (m) =>
          m.messageKind !== 'task_activity_notification' &&
          !shouldExcludeInboxTextFromReplyCandidates(typeof m.text === 'string' ? m.text : '')
      ),
    [effectiveMessages]
  );

  // Resolve the expanded item from filtered messages
  const expandedItem = useMemo<TimelineItem | null>(() => {
    if (!expandedItemKey) {
      return null;
    }
    if (!expandedItemKey.startsWith('thoughts-')) {
      const msg = activityTimelineMessages.find((m) => toMessageKey(m) === expandedItemKey);
      return msg ? { type: 'message', message: msg } : null;
    }
    const allItems = groupTimelineItems(activityTimelineMessages);
    return (
      allItems.find(
        (item) =>
          item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === expandedItemKey
      ) ?? null
    );
  }, [expandedItemKey, activityTimelineMessages]);

  // Auto-clear stale expanded key
  useEffect(() => {
    if (expandedItemKey && expandedItem === null) {
      setExpandedItemKey(null);
    }
  }, [expandedItemKey, expandedItem]);

  const handleExpandItem = useCallback((key: string) => {
    setExpandedItemKey(key);
  }, []);

  const handleExpandDialogChange = useCallback((open: boolean) => {
    if (!open) setExpandedItemKey(null);
  }, []);

  const { readSet, markRead, markAllRead } = useTeamMessagesRead(teamName);
  const { expandedSet, toggle: toggleExpandOverride } = useTeamMessagesExpanded(teamName);

  const messagesUnreadCount = useMemo(
    () => filteredMessages.filter((m) => !m.read && !readSet.has(toMessageKey(m))).length,
    [filteredMessages, readSet]
  );

  const handleMessageVisible = useCallback(
    (message: InboxMessage) => markRead(toMessageKey(message)),
    [markRead]
  );

  const readState = useMemo(() => ({ readSet, getMessageKey: toMessageKey }), [readSet]);

  const { teamNames, teamColorByName } = useStableTeamMentionMeta(teams);

  const handleMarkAllRead = useCallback(() => {
    const keys = filteredMessages
      .filter((m) => !m.read && !readSet.has(toMessageKey(m)))
      .map((m) => toMessageKey(m));
    markAllRead(keys);
  }, [filteredMessages, readSet, markAllRead]);

  // Auto-clear pending replies when a member actually responds
  useEffect(() => {
    if (Object.keys(pendingRepliesByMember).length === 0) return;
    const next = reconcilePendingRepliesByMember(pendingRepliesByMember, replyCandidateMessages);
    if (next !== pendingRepliesByMember) onPendingReplyChange(() => next);
  }, [onPendingReplyChange, pendingRepliesByMember, replyCandidateMessages]);

  const handleSend = useCallback(
    (
      member: string,
      text: string,
      summary?: string,
      attachments?: Parameters<typeof sendTeamMessage>[1] extends { attachments?: infer A }
        ? A
        : never,
      actionMode?: AgentActionMode,
      taskRefs?: TaskRef[],
      slashCommand?: SlashCommandMeta
    ) => {
      const sentAtMs = Date.now();
      onPendingReplyChange((prev) => ({ ...prev, [member]: sentAtMs }));
      void sendTeamMessage(teamName, {
        member,
        text,
        summary,
        attachments,
        actionMode,
        taskRefs,
        slashCommand,
        sessionKey:
          selectedSessionKey && selectedSessionKey !== '__unassigned__'
            ? selectedSessionKey
            : undefined,
      })
        .then((result) => {
          if (
            result?.runtimeDelivery?.attempted === true &&
            result.runtimeDelivery.delivered === false
          ) {
            onPendingReplyChange((prev) => {
              if (prev[member] !== sentAtMs) return prev;
              const next = { ...prev };
              delete next[member];
              return next;
            });
          }
        })
        .catch(() => {
          onPendingReplyChange((prev) => {
            if (prev[member] !== sentAtMs) return prev;
            const next = { ...prev };
            delete next[member];
            return next;
          });
        });
    },
    [teamName, sendTeamMessage, onPendingReplyChange, selectedSessionKey]
  );

  const moveToInline = useCallback(() => {
    onPositionChange('inline');
  }, [onPositionChange]);

  const moveToSidebar = useCallback(() => {
    onPositionChange('sidebar');
  }, [onPositionChange]);

  const moveToBottomSheet = useCallback(() => {
    setBottomSheetSnapIndex(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
    onPositionChange('bottom-sheet');
  }, [onPositionChange]);

  const snapBottomSheetTo = useCallback((snapIndex: number) => {
    setBottomSheetSnapIndex(snapIndex);
    bottomSheetRef.current?.snapTo(snapIndex);
  }, []);

  const toggleBottomSheetExpansion = useCallback(() => {
    if (bottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX) {
      snapBottomSheetTo(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
      return;
    }
    snapBottomSheetTo(BOTTOM_SHEET_COLLAPSED_SNAP_INDEX);
  }, [bottomSheetSnapIndex, snapBottomSheetTo]);

  const bottomSheetSnapPoints = useMemo(() => {
    const maxOpenHeight =
      bottomSheetMountHeight > 0
        ? Math.max(bottomSheetMountHeight - 1, 96)
        : Number.POSITIVE_INFINITY;
    const collapsedHeight = Math.min(BOTTOM_SHEET_HEADER_HEIGHT, maxOpenHeight);
    const composerHeight = Math.min(
      Math.max(collapsedHeight + bottomSheetStickyTopHeight, collapsedHeight + 120),
      maxOpenHeight
    );
    const centeredHeight = Math.min(
      Math.max(
        bottomSheetMountHeight > 0 ? Math.round(bottomSheetMountHeight * 0.58) : 520,
        composerHeight + 140
      ),
      maxOpenHeight
    );

    return [0, collapsedHeight, composerHeight, centeredHeight, 1];
  }, [bottomSheetMountHeight, bottomSheetStickyTopHeight]);

  const normalizedBottomSheetSnapIndex = useMemo(() => {
    return Math.min(
      Math.max(bottomSheetSnapIndex, BOTTOM_SHEET_COLLAPSED_SNAP_INDEX),
      BOTTOM_SHEET_FULL_SNAP_INDEX
    );
  }, [bottomSheetSnapIndex]);

  // ---- Shared content (used in both modes) ----
  const searchAndFilterControls = (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <input
          type="text"
          placeholder="搜索..."
          value={messagesSearchQuery}
          onChange={(e) => setMessagesSearchQuery(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
        />
        {messagesSearchQuery && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={() => setMessagesSearchQuery('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <MessagesFilterPopover
        teamName={teamName}
        members={members}
        filter={messagesFilter}
        messages={sessionScopedMessages}
        open={messagesFilterOpen}
        onOpenChange={setMessagesFilterOpen}
        onApply={setMessagesFilter}
      />
    </div>
  );

  const searchAndFilterBar = (
    <div className="flex items-center gap-2">
      {searchAndFilterControls}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-events-auto size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={(e) => {
              e.stopPropagation();
              setMessagesCollapsed((v) => !v);
            }}
          >
            {messagesCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {messagesCollapsed ? '展开全部动态' : '折叠全部动态'}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  const messagesContent = (
    <div className="pb-14">
      <MessageComposer
        teamName={teamName}
        members={members}
        isTeamAlive={isTeamAlive}
        sending={sendingMessage}
        sendError={sendMessageError}
        sendWarning={sendMessageWarning}
        sendDebugDetails={sendMessageDebugDetails}
        lastResult={lastSendMessageResult}
        textareaRef={composerTextareaRef}
        onSend={handleSend}
      />
      {showPositionControls ? participantFilterBar : null}
      <StatusBlock
        members={members}
        tasks={tasks}
        messages={sessionScopedMessages}
        pendingRepliesByMember={pendingRepliesByMember}
        layout="flow"
        position="inline"
        onMemberClick={onMemberClick}
        onTaskClick={onTaskClick}
      />
      <ActivityTimeline
        messages={activityTimelineMessages}
        teamName={teamName}
        members={members}
        readState={readState}
        allCollapsed={messagesCollapsed}
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
        onCreateTaskFromMessage={undefined}
        onReplyToMessage={onReplyToMessage}
        onMessageVisible={handleMessageVisible}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
        onExpandItem={handleExpandItem}
        onExpandContent={handleExpandContent}
        viewport={activityTimelineViewport}
      />
      {hasMore && (
        <div className="flex justify-center py-2">
          <div className="flex flex-col items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-text-muted"
              aria-busy={loadingOlderMessages}
              disabled={loadingOlderMessages}
              onClick={() => void loadOlderMessages()}
            >
              加载更早动态
            </Button>
            <span className="text-[10px] text-[var(--color-text-muted)]">
              已加载 {loadedMessageCount} 条
            </span>
          </div>
        </div>
      )}
      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItemKey !== null}
        onOpenChange={handleExpandDialogChange}
        teamName={teamName}
        members={members}
        onCreateTaskFromMessage={undefined}
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

  // ---- Sidebar mode ----
  if (position === 'sidebar') {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
          <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">动态</span>
          {filteredMessages.length > 0 && (
            <Badge
              variant="secondary"
              className="px-1.5 py-0.5 text-[10px] font-normal leading-none"
            >
              {filteredMessages.length}
            </Badge>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-indigo-600 dark:text-indigo-400"
                >
                  {messagesUnreadCount} 条新动态
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">{messagesUnreadCount} 条未读</TooltipContent>
            </Tooltip>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-indigo-400 transition-colors hover:bg-indigo-500/10"
                  onClick={handleMarkAllRead}
                >
                  <CheckCheck size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">全部标为已读</TooltipContent>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={() => setMessagesCollapsed((v) => !v)}
                  aria-label={messagesCollapsed ? '展开全部动态' : '折叠全部动态'}
                >
                  {messagesCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {messagesCollapsed ? '展开全部动态' : '折叠全部动态'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={() => setMessagesSearchBarVisible((v) => !v)}
                  aria-label={messagesSearchBarVisible ? '隐藏动态搜索' : '显示动态搜索'}
                >
                  {messagesSearchBarVisible ? <X size={14} /> : <Search size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {messagesSearchBarVisible ? '隐藏搜索' : '搜索动态'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={moveToInline}
                  aria-label="将动态移到页面内面板"
                >
                  <PanelLeftClose size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">移到页面内</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Search & filter bar (toggleable) */}
        {messagesSearchBarVisible && (
          <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
            {searchAndFilterControls}
          </div>
        )}
        {/* Scrollable content */}
        <div
          ref={sidebarScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-14 pr-3 pt-2"
          onScroll={(e) => {
            const scrollTop = e.currentTarget.scrollTop;
            setMessagesScrollTop(scrollTop);
            maybeAutoLoadOlderMessages(scrollTop);
          }}
        >
          <div className="pl-3">
            <MessageComposer
              teamName={teamName}
              members={members}
              isTeamAlive={isTeamAlive}
              sending={sendingMessage}
              sendError={sendMessageError}
              sendWarning={sendMessageWarning}
              sendDebugDetails={sendMessageDebugDetails}
              lastResult={lastSendMessageResult}
              textareaRef={composerTextareaRef}
              onSend={handleSend}
            />
            {showPositionControls ? participantFilterBar : null}
            <StatusBlock
              members={members}
              tasks={tasks}
              messages={sessionScopedMessages}
              pendingRepliesByMember={pendingRepliesByMember}
              layout="flow"
              position="sidebar"
              onMemberClick={onMemberClick}
              onTaskClick={onTaskClick}
            />{' '}
          </div>
          <ActivityTimeline
            messages={activityTimelineMessages}
            teamName={teamName}
            members={members}
            readState={readState}
            allCollapsed={messagesCollapsed}
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
            onCreateTaskFromMessage={undefined}
            onReplyToMessage={onReplyToMessage}
            onMessageVisible={handleMessageVisible}
            onRestartTeam={onRestartTeam}
            onTaskIdClick={onTaskIdClick}
            onExpandItem={handleExpandItem}
            onExpandContent={handleExpandContent}
            viewport={activityTimelineViewport}
          />
          {hasMore && (
            <div className="flex justify-center py-2">
              <div className="flex flex-col items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-text-muted"
                  aria-busy={loadingOlderMessages}
                  disabled={loadingOlderMessages}
                  onClick={() => void loadOlderMessages()}
                >
                  加载更早动态
                </Button>
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  已加载 {loadedMessageCount} 条
                </span>
              </div>
            </div>
          )}
          <MessageExpandDialog
            expandedItem={expandedItem}
            open={expandedItemKey !== null}
            onOpenChange={handleExpandDialogChange}
            teamName={teamName}
            members={members}
            onCreateTaskFromMessage={undefined}
            onReplyToMessage={onReplyToMessage}
            onMemberClick={onMemberClick}
            onTaskIdClick={onTaskIdClick}
            onRestartTeam={onRestartTeam}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={openTeamTab}
          />
        </div>
      </div>
    );
  }

  if (position === 'bottom-sheet') {
    if (!mountPoint) {
      return <div className="hidden" aria-hidden="true" />;
    }

    const isBottomSheetCollapsed =
      normalizedBottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX;

    return (
      <Sheet
        ref={bottomSheetRef}
        isOpen
        onClose={moveToInline}
        mountPoint={mountPoint}
        avoidKeyboard={false}
        detent="full"
        snapPoints={bottomSheetSnapPoints}
        initialSnap={normalizedBottomSheetSnapIndex}
        onSnap={setBottomSheetSnapIndex}
        disableDismiss
        disableScrollLocking
        style={{ zIndex: 30 }}
        className="!pointer-events-none !absolute !inset-0"
        unstyled
      >
        <Sheet.Container
          unstyled
          className="flex max-h-full w-full flex-col overflow-hidden rounded-t-[20px] border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] shadow-[0_-18px_48px_rgba(0,0,0,0.35)]"
        >
          <Sheet.Header
            unstyled
            className="shrink-0 cursor-grab select-none border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] active:cursor-grabbing"
          >
            <div className="relative h-10 px-3">
              <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center">
                <Sheet.DragIndicator
                  className="!h-1 !w-9 cursor-grab !rounded-full active:cursor-grabbing"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--color-text-muted) 45%, transparent)',
                  }}
                />
              </div>
              <div className="flex h-full items-center gap-1.5">
                <MessageSquare size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-[13px] font-medium text-[var(--color-text)]">动态</span>
                {filteredMessages.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="px-1 py-0 text-[9px] font-normal leading-none"
                  >
                    {filteredMessages.length}
                  </Badge>
                )}
                {messagesUnreadCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="bg-indigo-500/20 px-1 py-0 text-[9px] font-normal leading-none text-indigo-600 dark:text-indigo-400"
                      >
                        {messagesUnreadCount} 条新动态
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top">{messagesUnreadCount} 条未读</TooltipContent>
                  </Tooltip>
                )}
                <div
                  className="ml-auto flex items-center gap-1"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {messagesUnreadCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-[22px] p-0 text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300"
                          onClick={handleMarkAllRead}
                          aria-label="将全部动态标为已读"
                        >
                          <CheckCheck size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">全部标为已读</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={() => setMessagesCollapsed((value) => !value)}
                        aria-label={messagesCollapsed ? '展开全部动态' : '折叠全部动态'}
                      >
                        {messagesCollapsed ? (
                          <ChevronsUpDown size={14} />
                        ) : (
                          <ChevronsDownUp size={14} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {messagesCollapsed ? '展开全部动态' : '折叠全部动态'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={() => setMessagesSearchBarVisible((value) => !value)}
                        aria-label={messagesSearchBarVisible ? '隐藏动态搜索' : '显示动态搜索'}
                      >
                        {messagesSearchBarVisible ? <X size={14} /> : <Search size={14} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {messagesSearchBarVisible ? '隐藏搜索' : '搜索动态'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={toggleBottomSheetExpansion}
                        aria-label={
                          isBottomSheetCollapsed ? '展开底部动态面板' : '折叠底部动态面板'
                        }
                      >
                        {isBottomSheetCollapsed ? (
                          <PanelBottomOpen size={14} />
                        ) : (
                          <PanelBottomClose size={14} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isBottomSheetCollapsed ? '展开面板' : '折叠面板'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={moveToInline}
                        aria-label="将动态移到页面内面板"
                      >
                        <PanelBottom size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">移到页面内</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={moveToSidebar}
                        aria-label="将动态移到侧边栏"
                      >
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">移到侧边栏</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          </Sheet.Header>
          {!isBottomSheetCollapsed && (
            <Sheet.Content
              className="min-h-0 bg-[var(--color-surface-sidebar)]"
              scrollClassName="flex min-h-full flex-col"
              scrollRef={bottomSheetScrollRef}
              disableDrag={(state) => state.scrollPosition !== 'top'}
            >
              <div
                ref={bottomSheetStickyTopRef}
                className="sticky top-0 z-[1] shrink-0 border-b border-[var(--color-border)] backdrop-blur"
                style={{
                  backgroundColor: 'var(--color-surface-sidebar)',
                }}
              >
                {messagesSearchBarVisible && (
                  <div className="border-b border-[var(--color-border)] px-3 py-2">
                    {searchAndFilterControls}
                  </div>
                )}
                <div className="p-3">
                  <MessageComposer
                    teamName={teamName}
                    layout="compact"
                    members={members}
                    isTeamAlive={isTeamAlive}
                    sending={sendingMessage}
                    sendError={sendMessageError}
                    sendWarning={sendMessageWarning}
                    sendDebugDetails={sendMessageDebugDetails}
                    lastResult={lastSendMessageResult}
                    textareaRef={composerTextareaRef}
                    onSend={handleSend}
                  />
                  {showPositionControls ? participantFilterBar : null}
                </div>
              </div>
              <div className="shrink-0 px-3 pt-2">
                <StatusBlock
                  members={members}
                  tasks={tasks}
                  messages={sessionScopedMessages}
                  pendingRepliesByMember={pendingRepliesByMember}
                  layout="flow"
                  position="inline"
                  onMemberClick={onMemberClick}
                  onTaskClick={onTaskClick}
                />
              </div>
              <div className="flex-1 px-3 pb-4 pt-2">
                <ActivityTimeline
                  messages={activityTimelineMessages}
                  teamName={teamName}
                  members={members}
                  readState={readState}
                  allCollapsed={messagesCollapsed}
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
                  onCreateTaskFromMessage={undefined}
                  onReplyToMessage={onReplyToMessage}
                  onMessageVisible={handleMessageVisible}
                  onRestartTeam={onRestartTeam}
                  onTaskIdClick={onTaskIdClick}
                  onExpandItem={handleExpandItem}
                  onExpandContent={handleExpandContent}
                  viewport={activityTimelineViewport}
                />
                {hasMore && (
                  <div className="flex justify-center py-2">
                    <div className="flex flex-col items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-text-muted"
                        aria-busy={loadingOlderMessages}
                        disabled={loadingOlderMessages}
                        onClick={() => void loadOlderMessages()}
                      >
                        加载更早动态
                      </Button>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        已加载 {loadedMessageCount} 条
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <MessageExpandDialog
                expandedItem={expandedItem}
                open={expandedItemKey !== null}
                onOpenChange={handleExpandDialogChange}
                teamName={teamName}
                members={members}
                onCreateTaskFromMessage={undefined}
                onReplyToMessage={onReplyToMessage}
                onMemberClick={onMemberClick}
                onTaskIdClick={onTaskIdClick}
                onRestartTeam={onRestartTeam}
                teamNames={teamNames}
                teamColorByName={teamColorByName}
                onTeamClick={openTeamTab}
              />
            </Sheet.Content>
          )}
        </Sheet.Container>
      </Sheet>
    );
  }

  // ---- Inline mode (wrapped in CollapsibleTeamSection) ----
  return (
    <CollapsibleTeamSection
      sectionId="messages"
      title={sectionTitle ?? '动态'}
      icon={<MessageSquare size={14} />}
      badge={filteredMessages.length}
      secondaryBadge={
        filteredMessages.length > 0 && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
      }
      afterBadge={
        messagesUnreadCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-indigo-400 transition-colors hover:bg-indigo-500/10"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkAllRead();
                }}
              >
                <CheckCheck size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">全部标为已读</TooltipContent>
          </Tooltip>
        ) : undefined
      }
      headerExtra={
        showPositionControls ? (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveToBottomSheet();
                  }}
                  aria-label="将动态移到底部面板"
                >
                  <PanelBottom size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">移到底部面板</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    moveToSidebar();
                  }}
                  aria-label="将动态移到侧边栏"
                >
                  <PanelLeft size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">移到侧边栏</TooltipContent>
            </Tooltip>
          </div>
        ) : undefined
      }
      defaultOpen
      action={<div className="flex items-center gap-2 px-2">{searchAndFilterBar}</div>}
    >
      {messagesContent}
    </CollapsibleTeamSection>
  );
});

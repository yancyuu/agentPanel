import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamIsAliveForName,
  selectTeamMessages,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import {
  getInboxThreadReadState,
  markInboxThreadRead,
  subscribeInboxThreadRead,
} from '../services/inboxThreadReadStorage';
import {
  buildInboxThreads,
  type DraftInboxThread,
  type InboxThreadProjection,
} from '../utils/inboxThreadProjection';

import type {
  AgentActionMode,
  AttachmentPayload,
  ResolvedTeamMember,
  SlashCommandMeta,
  TaskRef,
} from '@shared/types';

function createConversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `conversation-${crypto.randomUUID()}`;
  }
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface InboxRecipientOption {
  teamName: string;
  teamDisplayName: string;
  memberName: string;
}

export interface InboxThreadsState {
  threads: InboxThreadProjection[];
  selectedThread: InboxThreadProjection | null;
  selectedKey: string | null;
  query: string;
  setQuery(query: string): void;
  teamFilter: string;
  setTeamFilter(teamName: string): void;
  teamOptions: [string, string][];
  recipientOptions: InboxRecipientOption[];
  createThread(teamName: string, memberName: string): void;
  selectThread(key: string): void;
  refresh(): void;
  loading: boolean;
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  sendWarning: string | null;
  sendDebugDetails: ReturnType<typeof useStore.getState>['sendMessageDebugDetails'];
  lastResult: ReturnType<typeof useStore.getState>['lastSendMessageResult'];
  navigationRequestAt: number | null;
  sendMessage(
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: AgentActionMode,
    taskRefs?: TaskRef[],
    slashCommand?: SlashCommandMeta
  ): Promise<void>;
}

export function useInboxThreads(): InboxThreadsState {
  const {
    teams,
    teamMessagesByName,
    pendingIntent,
    refreshTeamMessagesHead,
    refreshTeamData,
    fetchTeams,
    clearPendingIntent,
    setInboxHasUnreadMessages,
    sendTeamMessage,
    sendingMessage,
    sendMessageError,
    sendMessageWarning,
    sendMessageDebugDetails,
    lastSendMessageResult,
  } = useStore(
    useShallow((state) => ({
      teams: state.teams,
      teamMessagesByName: state.teamMessagesByName,
      pendingIntent: state.pendingInboxThreadIntent,
      refreshTeamMessagesHead: state.refreshTeamMessagesHead,
      refreshTeamData: state.refreshTeamData,
      fetchTeams: state.fetchTeams,
      clearPendingIntent: state.clearPendingInboxThreadIntent,
      setInboxHasUnreadMessages: state.setInboxHasUnreadMessages,
      sendTeamMessage: state.sendTeamMessage,
      sendingMessage: state.sendingMessage,
      sendMessageError: state.sendMessageError,
      sendMessageWarning: state.sendMessageWarning,
      sendMessageDebugDetails: state.sendMessageDebugDetails,
      lastSendMessageResult: state.lastSendMessageResult,
    }))
  );
  const activeTeams = useMemo(
    () => teams.filter((team) => !team.deletedAt && !team.pendingDelete),
    [teams]
  );
  const readAtByThread = useSyncExternalStore(
    subscribeInboxThreadRead,
    getInboxThreadReadState,
    getInboxThreadReadState
  );
  const [draft, setDraft] = useState<DraftInboxThread | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [navigationRequestAt, setNavigationRequestAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');

  useEffect(() => {
    void fetchTeams();
  }, [fetchTeams]);

  useEffect(() => {
    for (const team of activeTeams) {
      void refreshTeamMessagesHead(team.teamName).catch(() => undefined);
    }
  }, [activeTeams, refreshTeamMessagesHead]);

  const messagesByTeam = useMemo(
    () =>
      Object.fromEntries(
        activeTeams.map((team) => [
          team.teamName,
          selectTeamMessages({ teamMessagesByName }, team.teamName),
        ])
      ),
    [activeTeams, teamMessagesByName]
  );

  const allThreads = useMemo(
    () => buildInboxThreads({ teams: activeTeams, messagesByTeam, readAtByThread, draft }),
    [activeTeams, draft, messagesByTeam, readAtByThread]
  );

  const openDraft = useCallback(
    (
      teamName: string,
      memberName: string,
      options?: { conversationId?: string; initialText?: string; requestedAt?: number }
    ): void => {
      const normalizedTeamName = teamName.trim();
      const normalizedMemberName = memberName.trim();
      if (!normalizedTeamName || !normalizedMemberName) return;

      const nextDraft: DraftInboxThread = {
        teamName: normalizedTeamName,
        memberName: normalizedMemberName,
        conversationId: options?.conversationId?.trim() || createConversationId(),
        createdAt: new Date().toISOString(),
        initialText: options?.initialText,
      };
      setDraft(nextDraft);
      setSelectedKey(`${nextDraft.teamName}:${nextDraft.conversationId}`);
      setQuery('');
      setTeamFilter('all');
      setNavigationRequestAt(options?.requestedAt ?? Date.now());
    },
    []
  );

  useEffect(() => {
    if (!pendingIntent) return;
    openDraft(pendingIntent.teamName, pendingIntent.memberName, {
      conversationId: pendingIntent.conversationId,
      initialText: pendingIntent.initialText,
      requestedAt: pendingIntent.requestedAt,
    });
    clearPendingIntent();
  }, [clearPendingIntent, openDraft, pendingIntent]);

  const threads = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    return allThreads.filter((thread) => {
      if (teamFilter !== 'all' && thread.teamName !== teamFilter) return false;
      if (!normalizedQuery) return true;
      return [
        thread.participant,
        thread.teamDisplayName,
        thread.subject,
        thread.preview,
        ...thread.messages.flatMap((message) => [
          message.from,
          message.to ?? '',
          message.summary ?? '',
          message.text,
        ]),
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
    });
  }, [allThreads, query, teamFilter]);

  useEffect(() => {
    if (threads.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey && threads.some((thread) => thread.key === selectedKey)) return;
    setSelectedKey(threads[0].key);
  }, [selectedKey, threads]);

  const selectedThread = threads.find((thread) => thread.key === selectedKey) ?? null;
  const teamOptions = useMemo(() => {
    const labels = new Map(activeTeams.map((team) => [team.teamName, team.displayName]));
    return Array.from(new Set(allThreads.map((thread) => thread.teamName)))
      .map((teamName) => [teamName, labels.get(teamName) ?? teamName] as [string, string])
      .sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'));
  }, [activeTeams, allThreads]);
  const recipientOptions = useMemo<InboxRecipientOption[]>(() => {
    const seen = new Set<string>();
    const options: InboxRecipientOption[] = [];
    for (const team of activeTeams) {
      const members =
        team.members && team.members.length > 0
          ? team.members
          : [{ name: team.displayName || team.teamName }];
      for (const member of members) {
        const memberName = member.name?.trim();
        if (!memberName) continue;
        const key = `${team.teamName}\u0000${memberName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          teamName: team.teamName,
          teamDisplayName: team.displayName,
          memberName,
        });
      }
    }
    return options.sort((left, right) => {
      const teamOrder = left.teamDisplayName.localeCompare(right.teamDisplayName, 'zh-CN');
      return teamOrder || left.memberName.localeCompare(right.memberName, 'zh-CN');
    });
  }, [activeTeams]);

  useEffect(() => {
    if (teamFilter === 'all' || teamOptions.some(([teamName]) => teamName === teamFilter)) return;
    setTeamFilter('all');
  }, [teamFilter, teamOptions]);

  useEffect(() => {
    if (!selectedThread || selectedThread.messages.length === 0) return;
    const latestAt = Date.parse(selectedThread.updatedAt);
    if (Number.isFinite(latestAt)) markInboxThreadRead(selectedThread.key, latestAt);
  }, [selectedThread]);

  const allTeamsHydrated =
    activeTeams.length > 0 &&
    activeTeams.every((team) => teamMessagesByName[team.teamName]?.headHydrated);
  useEffect(() => {
    if (!allTeamsHydrated) return;
    setInboxHasUnreadMessages(allThreads.some((thread) => thread.unread));
  }, [allTeamsHydrated, allThreads, setInboxHasUnreadMessages]);

  useEffect(() => {
    if (!selectedThread) return;
    void refreshTeamData(selectedThread.teamName).catch(() => undefined);
  }, [refreshTeamData, selectedThread]);

  const members = useStore((state) =>
    selectedThread ? selectResolvedMembersForTeamName(state, selectedThread.teamName) : []
  );
  const isTeamAlive = useStore((state) =>
    selectedThread ? selectTeamIsAliveForName(state, selectedThread.teamName) : undefined
  );
  const effectiveMembers = useMemo(() => {
    if (!selectedThread || members.some((member) => member.name === selectedThread.participant)) {
      return members;
    }
    return [
      ...members,
      {
        name: selectedThread.participant,
        status: 'unknown' as const,
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: selectedThread.messages.length,
      },
    ];
  }, [members, selectedThread]);

  const refresh = useCallback(() => {
    for (const team of activeTeams)
      void refreshTeamMessagesHead(team.teamName).catch(() => undefined);
  }, [activeTeams, refreshTeamMessagesHead]);

  const selectThread = useCallback((key: string) => setSelectedKey(key), []);

  const sendMessage = useCallback(
    async (
      recipient: string,
      text: string,
      summary?: string,
      attachments?: AttachmentPayload[],
      actionMode?: AgentActionMode,
      taskRefs?: TaskRef[],
      slashCommand?: SlashCommandMeta
    ) => {
      if (!selectedThread) return;
      await sendTeamMessage(selectedThread.teamName, {
        member: recipient,
        text,
        summary,
        attachments,
        actionMode,
        taskRefs,
        slashCommand,
        conversationId: selectedThread.conversationId,
        replyToConversationId: selectedThread.conversationId,
        sessionKey: `${selectedThread.teamName}:member:${recipient}`,
        to: recipient,
        source: 'user_sent',
      });
      setDraft((current) =>
        current?.conversationId === selectedThread.conversationId ? null : current
      );
    },
    [selectedThread, sendTeamMessage]
  );

  return {
    threads,
    selectedThread,
    selectedKey,
    query,
    setQuery,
    teamFilter,
    setTeamFilter,
    teamOptions,
    recipientOptions,
    createThread: openDraft,
    selectThread,
    refresh,
    loading: activeTeams.some((team) => teamMessagesByName[team.teamName]?.loadingHead),
    members: effectiveMembers,
    isTeamAlive,
    sending: sendingMessage,
    sendError: sendMessageError,
    sendWarning: sendMessageWarning,
    sendDebugDetails: sendMessageDebugDetails,
    lastResult: lastSendMessageResult,
    navigationRequestAt,
    sendMessage,
  };
}

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

export interface InboxTaskRecipientOption {
  kind?: 'agent' | 'squad';
  teamName: string;
  teamDisplayName: string;
  memberName: string;
  collaborationTeamSlug?: string;
  memberCount?: number;
}

export interface InboxTaskRecipientRequest {
  teamName: string;
  memberName: string;
  requestedAt: number;
  initialText?: string;
}

export interface InboxTaskRecipientsState {
  recipientOptions: InboxTaskRecipientOption[];
  requestedRecipient: InboxTaskRecipientRequest | null;
  navigationRequestAt: number | null;
}

interface CollaborationTeamOption {
  slug: string;
  displayName: string;
  memberTeamSlugs: string[];
}

/**
 * Lightweight recipient source for task creation.
 *
 * Unlike the legacy inbox-thread hook, this hook does not load private-message
 * history, mark message threads as read, or write the task-feedback unread dot.
 */
export function useInboxTaskRecipients(): InboxTaskRecipientsState {
  const { teams, pendingIntent, fetchTeams, clearPendingIntent } = useStore(
    useShallow((state) => ({
      teams: state.teams,
      pendingIntent: state.pendingInboxThreadIntent,
      fetchTeams: state.fetchTeams,
      clearPendingIntent: state.clearPendingInboxThreadIntent,
    }))
  );
  const [requestedRecipient, setRequestedRecipient] = useState<InboxTaskRecipientRequest | null>(
    null
  );
  const [collaborationTeams, setCollaborationTeams] = useState<CollaborationTeamOption[]>([]);

  useEffect(() => {
    void fetchTeams();
    void fetch('/api/collaboration/teams')
      .then(async (response) => {
        if (!response.ok) throw new Error('小队列表加载失败');
        return response.json() as Promise<CollaborationTeamOption[]>;
      })
      .then(setCollaborationTeams)
      .catch(() => setCollaborationTeams([]));
  }, [fetchTeams]);

  useEffect(() => {
    if (!pendingIntent) return;
    setRequestedRecipient({
      teamName: pendingIntent.teamName,
      memberName: pendingIntent.memberName,
      requestedAt: pendingIntent.requestedAt,
      initialText: pendingIntent.initialText,
    });
    clearPendingIntent();
  }, [clearPendingIntent, pendingIntent]);

  const recipientOptions = useMemo<InboxTaskRecipientOption[]>(() => {
    const seen = new Set<string>();
    const options: InboxTaskRecipientOption[] = [];
    for (const team of teams) {
      if (team.deletedAt || team.pendingDelete) continue;
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
    for (const team of collaborationTeams) {
      options.push({
        kind: 'squad',
        teamName: team.slug,
        teamDisplayName: '小队',
        memberName: team.displayName,
        collaborationTeamSlug: team.slug,
        memberCount: team.memberTeamSlugs.length,
      });
    }
    return options.sort((left, right) => {
      const kindOrder = (left.kind === 'squad' ? 1 : 0) - (right.kind === 'squad' ? 1 : 0);
      if (kindOrder !== 0) return kindOrder;
      const teamOrder = left.teamDisplayName.localeCompare(right.teamDisplayName, 'zh-CN');
      return teamOrder || left.memberName.localeCompare(right.memberName, 'zh-CN');
    });
  }, [collaborationTeams, teams]);

  return {
    recipientOptions,
    requestedRecipient,
    navigationRequestAt: requestedRecipient?.requestedAt ?? null,
  };
}

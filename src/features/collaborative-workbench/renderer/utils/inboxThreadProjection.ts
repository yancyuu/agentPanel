import type { InboxMessage, TeamSummary } from '@shared/types';

export interface InboxThreadProjection {
  key: string;
  teamName: string;
  teamDisplayName: string;
  participant: string;
  conversationId: string;
  subject: string;
  preview: string;
  updatedAt: string;
  messages: InboxMessage[];
  unread: boolean;
  draft: boolean;
  initialText?: string;
}

export interface DraftInboxThread {
  teamName: string;
  memberName: string;
  conversationId: string;
  createdAt: string;
  initialText?: string;
}

function getCounterpart(teamName: string, message: InboxMessage): string {
  if (message.from === 'user') {
    const recipient = message.to?.trim();
    return recipient && recipient !== 'user' ? recipient : teamName;
  }
  return message.from.trim() || teamName;
}

function buildLegacyConversationId(
  teamName: string,
  message: InboxMessage,
  participant: string
): string {
  const sessionKey = message.session?.key?.trim();
  return `legacy:${teamName}:${sessionKey || participant}`;
}

function toThreadSubject(messages: InboxMessage[], participant: string): string {
  const explicitSummary = messages.find((message) => message.summary?.trim())?.summary?.trim();
  if (explicitSummary) return explicitSummary;
  const firstText = messages.find((message) => message.text.trim())?.text.trim() ?? '';
  const firstLine = firstText.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || `与 ${participant} 的私信`;
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildInboxThreads(params: {
  teams: TeamSummary[];
  messagesByTeam: Record<string, InboxMessage[]>;
  readAtByThread: Record<string, number>;
  draft?: DraftInboxThread | null;
}): InboxThreadProjection[] {
  const teamByName = new Map(params.teams.map((team) => [team.teamName, team]));
  const groups = new Map<
    string,
    {
      teamName: string;
      participant: string;
      conversationId: string;
      messages: InboxMessage[];
    }
  >();

  for (const [teamName, messages] of Object.entries(params.messagesByTeam)) {
    for (const message of messages) {
      if (!message.text.trim() || message.source === 'system_notification') continue;
      const participant = getCounterpart(teamName, message);
      const conversationId =
        message.conversationId?.trim() || buildLegacyConversationId(teamName, message, participant);
      const key = `${teamName}:${conversationId}`;
      const group = groups.get(key) ?? { teamName, participant, conversationId, messages: [] };
      group.messages.push(message);
      if (group.participant === teamName && participant !== teamName)
        group.participant = participant;
      groups.set(key, group);
    }
  }

  if (params.draft) {
    const key = `${params.draft.teamName}:${params.draft.conversationId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        teamName: params.draft.teamName,
        participant: params.draft.memberName,
        conversationId: params.draft.conversationId,
        messages: [],
      });
    }
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const messages = [...group.messages].sort(
        (left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp)
      );
      const latest = messages[messages.length - 1];
      const latestAt =
        latest?.timestamp ??
        (params.draft?.conversationId === group.conversationId
          ? params.draft.createdAt
          : new Date(0).toISOString());
      const latestFromAgent = [...messages].reverse().find((message) => message.from !== 'user');
      const unread =
        latestFromAgent != null &&
        timestampValue(latestFromAgent.timestamp) > (params.readAtByThread[key] ?? 0);
      const team = teamByName.get(group.teamName);
      return {
        key,
        teamName: group.teamName,
        teamDisplayName: team?.displayName ?? group.teamName,
        participant: group.participant,
        conversationId: group.conversationId,
        subject: toThreadSubject(messages, group.participant),
        preview: latest?.text.trim() || '新私信',
        updatedAt: latestAt,
        messages,
        unread,
        draft: messages.length === 0,
        initialText:
          params.draft?.conversationId === group.conversationId
            ? params.draft.initialText
            : undefined,
      };
    })
    .sort((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
}

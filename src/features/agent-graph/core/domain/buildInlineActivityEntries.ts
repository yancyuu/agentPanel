import { stripCrossTeamPrefix } from '@shared/constants/crossTeam';
import { getIdleGraphLabel } from '@shared/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { isLeadMember, isLeadMemberName } from '@shared/utils/leadDetection';

import { buildGraphMemberNodeIdAliasMap } from './graphOwnerIdentity';

import type { GraphActivityItem } from '@claude-teams/agent-graph';
import type {
  Delivery,
  InboxMessage,
  ResolvedTeamMember,
  TaskRef,
  TeamTaskWithKanban,
} from '@shared/types/team';

export interface InlineActivityEntry {
  ownerNodeId: string;
  graphItem: GraphActivityItem;
  message: InboxMessage;
  sourceKind: 'message' | 'delivery';
  sourceOrder: number | null;
}

export interface ActivityEntrySourceData {
  members: ResolvedTeamMember[];
  tasks: readonly TeamTaskWithKanban[];
  messages: readonly InboxMessage[];
}

export interface BuildInlineActivityEntriesArgs {
  data: ActivityEntrySourceData;
  teamName: string;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
}

export function getGraphLeadMemberName(
  data: Pick<ActivityEntrySourceData, 'members'>,
  teamName: string
): string {
  return data.members.find((member) => isLeadMember(member))?.name ?? `${teamName}-lead`;
}

export function buildInlineActivityEntries({
  data,
  teamName,
  leadId,
  leadName,
  ownerNodeIds,
}: BuildInlineActivityEntriesArgs): Map<string, InlineActivityEntry[]> {
  const entriesByOwnerNodeId = new Map<string, InlineActivityEntry[]>();
  const memberNodeIdByAlias = buildGraphMemberNodeIdAliasMap(
    teamName,
    data.members.filter((member) => !isLeadMember(member))
  );

  const appendEntry = (entry: InlineActivityEntry): void => {
    const targetOwnerNodeId = ownerNodeIds.has(entry.ownerNodeId) ? entry.ownerNodeId : leadId;
    const ownerEntries = entriesByOwnerNodeId.get(targetOwnerNodeId);
    if (ownerEntries) {
      ownerEntries.push(entry);
    } else {
      entriesByOwnerNodeId.set(targetOwnerNodeId, [entry]);
    }
  };

  for (const ownerNodeId of ownerNodeIds) {
    entriesByOwnerNodeId.set(ownerNodeId, []);
  }

  const orderedMessages = [...data.messages].sort((a, b) => {
    const ta = String(a.timestamp ?? '');
    const tb = String(b.timestamp ?? '');
    return ta.localeCompare(tb);
  });
  const messageSourceOrderByKey = new Map(
    data.messages.map((message, index) => [getActivityMessageKey(message), index] as const)
  );
  for (const message of orderedMessages) {
    const idleLabel = getIdleGraphLabel(message.text ?? '');
    if (!idleLabel && isInboxNoiseMessage(message.text ?? '')) {
      continue;
    }

    const ownerNodeId = resolveMessageOwnerNodeId({
      message,
      leadId,
      leadName,
      ownerNodeIds,
      memberNodeIdByAlias,
    });
    if (!ownerNodeId) {
      continue;
    }

    const crossTeamPreview =
      message.source === 'cross_team' || message.source === 'cross_team_sent'
        ? (message.summary ?? stripCrossTeamPrefix(message.text ?? '')).replace(
            /^\[cross-team\]\s*/i,
            ''
          )
        : undefined;
    const previewSource =
      message.source === 'cross_team' || message.source === 'cross_team_sent'
        ? crossTeamPreview
        : (message.summary ?? message.text);
    const graphItem: GraphActivityItem = {
      id: `activity:msg:${teamName}:${getActivityMessageKey(message)}`,
      kind: 'inbox_message',
      timestamp: message.timestamp,
      title: buildActivityMessageTitle(message, leadName),
      preview: idleLabel ?? buildActivityPreview(previewSource),
      authorLabel: buildParticipantLabel(message.from, leadName),
    };

    appendEntry({
      ownerNodeId,
      graphItem,
      message,
      sourceKind: 'message',
      sourceOrder: messageSourceOrderByKey.get(getActivityMessageKey(message)) ?? null,
    });
  }

  const orderedDeliveries = [...collectTaskDeliveries(data.tasks)].sort((a, b) => {
    const ta = String(a.delivery.deliveredAt ?? '');
    const tb = String(b.delivery.deliveredAt ?? '');
    return ta.localeCompare(tb);
  });
  for (const item of orderedDeliveries) {
    const author = item.task.owner?.trim() || 'agent';
    const ownerNodeId = resolveDeliveryOwnerNodeId({
      taskOwner: item.task.owner,
      author,
      leadId,
      leadName,
      ownerNodeIds,
      memberNodeIdByAlias,
    });
    if (!ownerNodeId) {
      continue;
    }

    const taskLabel = item.task.displayId ?? `#${item.task.id.slice(0, 6)}`;
    const preview = buildActivityPreview(item.delivery.summary?.trim() || item.delivery.result);
    const graphItem: GraphActivityItem = {
      id: `activity:delivery:${teamName}:${item.task.id}:${item.delivery.version}`,
      kind: 'task_delivery',
      timestamp: item.delivery.deliveredAt,
      title: `${taskLabel} ${item.task.subject}`.trim(),
      preview,
      taskId: item.task.id,
      taskDisplayId: item.task.displayId ?? undefined,
      authorLabel: author,
    };

    appendEntry({
      ownerNodeId,
      graphItem,
      message: buildDeliveryActivityMessage({
        teamName,
        leadName,
        task: item.task,
        delivery: item.delivery,
        author,
      }),
      sourceKind: 'delivery',
      sourceOrder: item.sourceOrder,
    });
  }

  for (const [ownerNodeId, entries] of entriesByOwnerNodeId) {
    entriesByOwnerNodeId.set(ownerNodeId, entries.toSorted(compareInlineActivityEntries));
  }

  return entriesByOwnerNodeId;
}

function collectTaskDeliveries(
  tasks: readonly TeamTaskWithKanban[]
): { task: TeamTaskWithKanban; delivery: Delivery; sourceOrder: number }[] {
  const items: { task: TeamTaskWithKanban; delivery: Delivery; sourceOrder: number }[] = [];
  let sourceOrder = 0;
  for (const task of tasks) {
    for (const delivery of task.deliveries ?? []) {
      items.push({ task, delivery, sourceOrder });
      sourceOrder += 1;
    }
  }
  return items;
}

function compareInlineActivityEntries(
  left: InlineActivityEntry,
  right: InlineActivityEntry
): number {
  const tl = String(left.graphItem.timestamp ?? '');
  const tr = String(right.graphItem.timestamp ?? '');
  const timestampDiff = tr.localeCompare(tl);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  if (
    left.sourceKind === right.sourceKind &&
    left.sourceOrder != null &&
    right.sourceOrder != null &&
    left.sourceOrder !== right.sourceOrder
  ) {
    return left.sourceOrder - right.sourceOrder;
  }

  return left.graphItem.id.localeCompare(right.graphItem.id);
}

function resolveMessageOwnerNodeId(args: {
  message: InboxMessage;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
  memberNodeIdByAlias: ReadonlyMap<string, string>;
}): string | null {
  const { message, leadId, leadName, ownerNodeIds, memberNodeIdByAlias } = args;
  if (message.source === 'cross_team' || message.source === 'cross_team_sent') {
    return leadId;
  }

  const fromId = resolveParticipantId(message.from ?? '', leadId, leadName, memberNodeIdByAlias);
  const toId = message.to
    ? resolveParticipantId(message.to, leadId, leadName, memberNodeIdByAlias)
    : leadId;

  if (toId !== leadId && ownerNodeIds.has(toId)) {
    return toId;
  }
  if (fromId !== leadId && ownerNodeIds.has(fromId)) {
    return fromId;
  }
  return ownerNodeIds.has(leadId) ? leadId : null;
}

function resolveDeliveryOwnerNodeId(args: {
  taskOwner: string | undefined;
  author: string;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
  memberNodeIdByAlias: ReadonlyMap<string, string>;
}): string | null {
  const { taskOwner, author, leadId, leadName, ownerNodeIds, memberNodeIdByAlias } = args;
  if (taskOwner) {
    const ownerId = resolveParticipantId(taskOwner, leadId, leadName, memberNodeIdByAlias);
    if (ownerNodeIds.has(ownerId)) {
      return ownerId;
    }
  }

  const authorId = resolveParticipantId(author, leadId, leadName, memberNodeIdByAlias);
  if (ownerNodeIds.has(authorId)) {
    return authorId;
  }
  return ownerNodeIds.has(leadId) ? leadId : null;
}

function buildActivityMessageTitle(message: InboxMessage, leadName: string): string {
  if (message.source === 'cross_team' || message.source === 'cross_team_sent') {
    const externalTeam = extractExternalTeamName(message.from ?? '') ?? 'external';
    return message.source === 'cross_team_sent'
      ? `${leadName} -> ${externalTeam}`
      : `${externalTeam} -> ${leadName}`;
  }

  const fromLabel = buildParticipantLabel(message.from, leadName);
  const toLabel = buildParticipantLabel(message.to ?? leadName, leadName);
  return `${fromLabel} -> ${toLabel}`;
}

function buildDeliveryActivityMessage(args: {
  teamName: string;
  leadName: string;
  task: TeamTaskWithKanban;
  delivery: Delivery;
  author: string;
}): InboxMessage {
  const { teamName, leadName, task, delivery, author } = args;
  const taskDisplayId = task.displayId ?? `#${task.id.slice(0, 6)}`;
  const summaryPreview =
    buildActivityPreview(delivery.summary?.trim() || delivery.result, 90) ?? task.subject;
  const summary = `${taskDisplayId} ${summaryPreview}`.trim();
  const recipient = task.owner && task.owner !== author ? task.owner : leadName;

  return {
    from: author,
    to: recipient,
    text: `交付 第 ${delivery.version} 版\n\n${delivery.result}`,
    timestamp: delivery.deliveredAt,
    read: true,
    summary,
    messageId: `graph-activity-delivery:${teamName}:${task.id}:${delivery.version}`,
    messageKind: 'task_activity_notification',
    source: 'runtime_delivery',
    taskRefs: buildTaskRefs(teamName, task),
  };
}

function buildTaskRefs(teamName: string, task: TeamTaskWithKanban): TaskRef[] | undefined {
  const displayId = task.displayId ?? `#${task.id.slice(0, 6)}`;
  return [
    {
      taskId: task.id,
      displayId,
      teamName,
    },
  ];
}

function buildActivityPreview(text: string | undefined, max = 180): string | undefined {
  const normalized = normalizeActivityText(text);
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
    : normalized;
}

function normalizeActivityText(text: string | undefined): string | undefined {
  let normalized = text?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return normalized;
  }
  normalized = normalized.replace(/#[a-f0-9]{6,}\s*/gi, '').trim();
  normalized = normalized.replace(/\|/g, ' - ');
  return normalized;
}

function getActivityMessageKey(message: InboxMessage): string {
  if (message.messageId && message.messageId.trim().length > 0) {
    return message.messageId;
  }
  return [
    message.timestamp,
    message.from ?? '',
    message.to ?? '',
    message.summary ?? '',
    message.text ?? '',
  ].join('\u0000');
}

function resolveParticipantId(
  name: string,
  leadId: string,
  leadName: string | undefined,
  memberNodeIdByAlias: ReadonlyMap<string, string>
): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'user' || isLeadMemberName(normalized)) {
    return leadId;
  }
  if (normalized === leadName?.trim().toLowerCase()) {
    return leadId;
  }
  return memberNodeIdByAlias.get(name) ?? leadId;
}

function buildParticipantLabel(name: string | undefined, leadName: string): string {
  if (!name) {
    return leadName;
  }
  const normalized = name.trim().toLowerCase();
  if (
    normalized === 'user' ||
    isLeadMemberName(normalized) ||
    normalized === leadName.trim().toLowerCase()
  ) {
    return leadName;
  }

  const dotIndex = name.indexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1);
  }

  return name;
}

function extractExternalTeamName(from: string): string | null {
  const dotIndex = from.indexOf('.');
  if (dotIndex <= 0) {
    return null;
  }
  return from.slice(0, dotIndex);
}

import type { LocalSessionSummary } from './LocalSessionScanner';
import type { CcSession } from '@shared/types/api';
import type { HermitBridgeSessionListItem } from '@shared/types/hermitBridge';

function toLastMessage(session: HermitBridgeSessionListItem): CcSession['lastMessage'] {
  return session.last_message
    ? {
        role: session.last_message.role,
        content: session.last_message.content,
        timestamp: session.last_message.timestamp,
      }
    : null;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeFeishuLarkChatId(value: string): string {
  return value.replace(/^oc_/i, 'c_');
}

function externalSessionIdentity(session: HermitBridgeSessionListItem): string | null {
  const [platform, chatId, userId] = session.session_key.split(':');
  if (!platform || !chatId || !userId) return null;
  if (platform !== 'feishu' && platform !== 'lark') return null;
  return `feishu:${normalizeFeishuLarkChatId(chatId)}:${userId}`;
}

function pickPreferredCcSession(
  current: HermitBridgeSessionListItem,
  candidate: HermitBridgeSessionListItem
): HermitBridgeSessionListItem {
  const currentHasLocal = Boolean(current.agent_session_id);
  const candidateHasLocal = Boolean(candidate.agent_session_id);
  if (currentHasLocal !== candidateHasLocal) return candidateHasLocal ? candidate : current;

  if (current.history_count !== candidate.history_count) {
    return candidate.history_count > current.history_count ? candidate : current;
  }

  return timestampMs(candidate.updated_at) > timestampMs(current.updated_at) ? candidate : current;
}

function dedupeCcSessionsByExternalIdentity(
  ccSessions: HermitBridgeSessionListItem[]
): HermitBridgeSessionListItem[] {
  const byIdentity = new Map<string, HermitBridgeSessionListItem>();
  const result: HermitBridgeSessionListItem[] = [];

  for (const session of ccSessions) {
    const identity = externalSessionIdentity(session);
    if (!identity) {
      result.push(session);
      continue;
    }

    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, session);
      continue;
    }

    byIdentity.set(identity, pickPreferredCcSession(existing, session));
  }

  return [...result, ...byIdentity.values()];
}

function mapCcOnlySession(session: HermitBridgeSessionListItem, projectId: string): CcSession {
  return {
    id: session.agent_session_id || session.id,
    title: session.name || session.session_key,
    projectId,
    sessionKey: session.session_key,
    platform: session.platform,
    userName: session.user_name ?? null,
    chatName: session.chat_name ?? null,
    active: session.active,
    live: session.live,
    historyCount: session.history_count,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    lastMessage: toLastMessage(session),
    hasLocalFile: false,
  };
}

export function filterHiddenTeamSessions(
  localSessions: LocalSessionSummary[],
  ccSessions: HermitBridgeSessionListItem[],
  hiddenIds: ReadonlySet<string>
): { localSessions: LocalSessionSummary[]; ccSessions: HermitBridgeSessionListItem[] } {
  if (hiddenIds.size === 0) {
    return { localSessions, ccSessions };
  }

  return {
    localSessions: localSessions.filter((session) => !hiddenIds.has(session.id)),
    ccSessions: ccSessions.filter((session) => {
      const ids = [session.id, session.agent_session_id].filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      );
      return ids.every((id) => !hiddenIds.has(id));
    }),
  };
}

export function mergeLocalAndCcSessions(
  localSessions: LocalSessionSummary[],
  ccSessions: HermitBridgeSessionListItem[],
  projectId: string
): CcSession[] {
  const dedupedCcSessions = dedupeCcSessionsByExternalIdentity(ccSessions);
  const localSessionIds = new Set(localSessions.map((session) => session.id));
  const ccByLocalSessionId = new Map(
    dedupedCcSessions
      .map((session) => [session.agent_session_id || session.id, session] as const)
      .filter(([localSessionId]) => localSessionIds.has(localSessionId))
  );

  const localResults = localSessions.map((session): CcSession => {
    const ccMeta = ccByLocalSessionId.get(session.id);
    return {
      id: session.id,
      title: session.title || session.id,
      projectId,
      sessionKey: ccMeta?.session_key ?? session.id,
      platform: ccMeta?.platform ?? 'local',
      userName: ccMeta?.user_name ?? null,
      chatName: ccMeta?.chat_name ?? null,
      active: session.active,
      live: session.live,
      historyCount: session.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastMessage: ccMeta ? toLastMessage(ccMeta) : null,
      hasLocalFile: true,
    };
  });

  const ccOnlyResults = dedupedCcSessions
    .filter((session) => !localSessionIds.has(session.agent_session_id || session.id))
    .map((session) => mapCcOnlySession(session, projectId));

  return [...localResults, ...ccOnlyResults].sort(
    (a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt)
  );
}

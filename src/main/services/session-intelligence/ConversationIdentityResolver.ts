import {
  formatIdentityFallback,
  looksLikeChannelId,
  normalizeOptionalString,
  parseExternalPlatformSessionKey,
  stableExternalPlatformUserId,
} from '@main/utils/externalPlatformSessionKey';

import {
  conversationIdentityKey,
  type ConversationIdentityRecord,
  ConversationIdentityStore,
} from './ConversationIdentityStore';

export interface ResolveIdentityInput {
  teamName: string;
  projectName: string;
  sessionKey: string;
  ccSessionId?: string;
  platform?: string;
  sessionName?: string;
  userName?: string;
  chatName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedConversationIdentity {
  platform: string;
  type: 'person' | 'group' | 'unknown';
  id?: string;
  userId?: string;
  chatId?: string;
  displayName: string;
  userName?: string;
  chatName?: string;
  confidence: 'exact-id' | 'name-only' | 'allowlist-fallback' | 'session-key-only' | 'missing-id';
  source: 'identity-store' | 'cc-session' | 'session-key' | 'local-fallback';
  isExternal: boolean;
}

export class ConversationIdentityResolver {
  constructor(private readonly store = new ConversationIdentityStore()) {}

  async readIdentityRecords(): Promise<Map<string, ConversationIdentityRecord>> {
    return this.store.readAll();
  }

  async writeIdentityRecords(records: Map<string, ConversationIdentityRecord>): Promise<void> {
    await this.store.writeAll(records);
  }

  observeCcSession(
    records: Map<string, ConversationIdentityRecord>,
    input: ResolveIdentityInput
  ): void {
    const parsed = parseExternalPlatformSessionKey(input.sessionKey);
    this.store.upsertInto(records, {
      teamName: input.teamName,
      projectName: input.projectName,
      platform: input.platform ?? parsed.platform ?? 'unknown',
      sessionKey: input.sessionKey,
      ccSessionId: input.ccSessionId,
      userId: parsed.userId,
      chatId: parsed.chatId,
      userName: normalizeOptionalString(input.userName),
      chatName: normalizeOptionalString(input.chatName),
      firstSeenAt: input.createdAt ?? new Date().toISOString(),
      lastSeenAt: input.updatedAt ?? new Date().toISOString(),
      source: 'cc-session-name',
    });
  }

  resolve(
    records: Map<string, ConversationIdentityRecord>,
    input: ResolveIdentityInput
  ): ResolvedConversationIdentity {
    const stored = records.get(conversationIdentityKey(input.teamName, input.sessionKey));
    const parsed = parseExternalPlatformSessionKey(input.sessionKey);
    const platform = stored?.platform ?? parsed.platform ?? input.platform ?? 'unknown';
    const rawUserName = stored?.userName ?? normalizeOptionalString(input.userName);
    const rawChatName = stored?.chatName ?? normalizeOptionalString(input.chatName);
    const userId =
      stableExternalPlatformUserId(platform, stored?.userId) ??
      stableExternalPlatformUserId(platform, parsed.userId);
    const chatId = stored?.chatId ?? parsed.chatId;
    const chatName = rawChatName && !looksLikeChannelId(rawChatName) ? rawChatName : undefined;
    const userName = rawUserName && !looksLikeChannelId(rawUserName) ? rawUserName : undefined;
    const type = chatName
      ? 'group'
      : chatId
        ? 'unknown'
        : userId || userName
          ? 'person'
          : 'unknown';
    const id = chatId ?? userId;
    const displayName =
      chatName ??
      userName ??
      (chatId ? formatIdentityFallback(platform, 'conversation', chatId) : undefined) ??
      (userId ? formatIdentityFallback(platform, 'person', userId) : undefined) ??
      input.sessionName ??
      input.sessionKey;

    const source = stored
      ? 'identity-store'
      : rawUserName || rawChatName
        ? 'cc-session'
        : parsed.userId || parsed.chatId
          ? 'session-key'
          : 'local-fallback';

    return {
      platform,
      type,
      id,
      userId,
      chatId,
      displayName,
      userName,
      chatName,
      confidence: id
        ? 'exact-id'
        : displayName === input.sessionKey
          ? 'session-key-only'
          : 'name-only',
      source,
      isExternal: parsed.kind === 'external-platform',
    };
  }
}

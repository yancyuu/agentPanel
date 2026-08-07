import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ConversationIdentityRecord {
  teamName: string;
  projectName: string;
  platform: string;
  sessionKey: string;
  ccSessionId?: string;
  userId?: string;
  chatId?: string;
  userName?: string;
  chatName?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: 'cc-session-name';
}

function telemetryRoot(): string {
  return path.join(process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit'), 'telemetry');
}

export function conversationIdentityStorePath(): string {
  return path.join(telemetryRoot(), 'conversation-identities.json');
}

export function conversationIdentityKey(teamName: string, sessionKey: string): string {
  return `${teamName}\0${sessionKey}`;
}

export class ConversationIdentityStore {
  constructor(private readonly filePath = conversationIdentityStorePath()) {}

  async readAll(): Promise<Map<string, ConversationIdentityRecord>> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { records?: ConversationIdentityRecord[] };
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      return new Map(
        records.map((record) => [
          conversationIdentityKey(record.teamName, record.sessionKey),
          record,
        ])
      );
    } catch {
      return new Map();
    }
  }

  async writeAll(records: Map<string, ConversationIdentityRecord>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({ schemaVersion: 1, records: [...records.values()] }, null, 2),
      'utf-8'
    );
    await rename(tmp, this.filePath);
  }

  upsertInto(
    records: Map<string, ConversationIdentityRecord>,
    next: ConversationIdentityRecord
  ): void {
    const key = conversationIdentityKey(next.teamName, next.sessionKey);
    const existing = records.get(key);
    records.set(key, {
      ...existing,
      ...next,
      userName: next.userName ?? existing?.userName,
      chatName: next.chatName ?? existing?.chatName,
      userId: next.userId ?? existing?.userId,
      chatId: next.chatId ?? existing?.chatId,
      firstSeenAt: existing?.firstSeenAt ?? next.firstSeenAt,
      lastSeenAt: next.lastSeenAt || existing?.lastSeenAt || new Date().toISOString(),
    });
  }
}

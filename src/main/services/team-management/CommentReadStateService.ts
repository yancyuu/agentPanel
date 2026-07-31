import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PersistedCommentReadEntry {
  readIds: string[];
  lastUpdated: number;
}

export type PersistedCommentReadState = Record<string, PersistedCommentReadEntry>;

interface CommentReadStateDocument {
  version: 1;
  tasks: PersistedCommentReadState;
}

const MAX_TASKS = 10_000;
const MAX_READ_IDS_PER_TASK = 5_000;
const MAX_ID_LENGTH = 512;

function sanitizeState(value: unknown): PersistedCommentReadState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: PersistedCommentReadState = {};
  for (const [taskKey, rawEntry] of Object.entries(value).slice(0, MAX_TASKS)) {
    if (!taskKey || taskKey.length > MAX_ID_LENGTH) continue;
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const candidate = rawEntry as { readIds?: unknown; lastUpdated?: unknown };
    const readIds = Array.isArray(candidate.readIds)
      ? [
          ...new Set(
            candidate.readIds.filter(
              (id): id is string =>
                typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
            )
          ),
        ].slice(0, MAX_READ_IDS_PER_TASK)
      : [];
    const lastUpdated =
      typeof candidate.lastUpdated === 'number' && Number.isFinite(candidate.lastUpdated)
        ? Math.max(0, candidate.lastUpdated)
        : 0;
    result[taskKey] = { readIds, lastUpdated };
  }
  return result;
}

export class CommentReadStateService {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(hermitHome: string) {
    this.filePath = path.join(hermitHome, 'workbench', 'comment-read-state.json');
  }

  async read(): Promise<PersistedCommentReadState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CommentReadStateDocument>;
      return sanitizeState(parsed.tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      return {};
    }
  }

  async write(state: unknown): Promise<PersistedCommentReadState> {
    const tasks = sanitizeState(state);
    const operation = this.writeQueue.then(async () => {
      const document: CommentReadStateDocument = { version: 1, tasks };
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return tasks;
  }
}

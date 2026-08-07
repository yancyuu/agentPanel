import { readFile } from 'node:fs/promises';

import { atomicWriteAsync } from './atomicWrite';

const writeQueues = new Map<string, Promise<unknown>>();

export async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Serialize read-modify-write updates for a shared local settings file and
 * commit each update atomically. Failed writes do not poison subsequent work.
 */
export function updateJsonObjectFile<T>(
  filePath: string,
  update: (current: Record<string, unknown>) => T | Promise<T>
): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readJsonObjectFile(filePath);
      const result = await update(current);
      await atomicWriteAsync(filePath, `${JSON.stringify(current, null, 2)}\n`);
      return result;
    });
  writeQueues.set(filePath, operation);
  void operation.finally(() => {
    if (writeQueues.get(filePath) === operation) writeQueues.delete(filePath);
  });
  return operation;
}

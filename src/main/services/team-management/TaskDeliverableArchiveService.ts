import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { teamRoot } from './TeamWorkspaceService';

import type { Task } from './TeamWorkspaceService';

interface DeliverableVersion {
  id: string;
  createdAt: string;
  deliveryVersion: number;
  resultFile: string;
  attachments: string[];
}

interface DeliverableManifest {
  schemaVersion: 1;
  taskId: string;
  title: string;
  assistant?: string | null;
  currentVersion: string;
  approvedAt: string;
  versions: DeliverableVersion[];
}

export interface ArchivedTaskDeliverable {
  outputDir: string;
  versionDir: string;
  versionId: string;
  resultPath: string;
  manifestPath: string;
}

export interface ArchiveTaskDeliverableOptions {
  teamName: string;
  task: Task;
  approvedAt?: Date;
  teamDir?: string;
}

function safePathSegment(value: string, fallback: string): string {
  const forbidden = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
  let normalized = '';
  for (const character of value.normalize('NFKC')) {
    const codePoint = character.codePointAt(0) ?? 0;
    const next =
      codePoint < 32 || forbidden.has(character) ? '-' : character.trim() ? character : ' ';
    if ((next === '-' || next === ' ') && normalized.endsWith(next)) continue;
    normalized += next;
  }
  normalized = normalized.trim();
  while (normalized.startsWith('.') || normalized.startsWith(' ')) normalized = normalized.slice(1);
  while (normalized.endsWith('.') || normalized.endsWith(' ')) normalized = normalized.slice(0, -1);
  normalized = normalized.slice(0, 80);
  return normalized || fallback;
}

function versionIdFor(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

async function readManifest(manifestPath: string): Promise<DeliverableManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as DeliverableManifest;
    return parsed?.schemaVersion === 1 && Array.isArray(parsed.versions) ? parsed : null;
  } catch {
    return null;
  }
}

function attachmentExtension(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  return '';
}

/**
 * Persist the latest approved delivery as an append-only version under
 * ~/.hermit/teams/<team>/outputs. Task input blobs remain independent from the
 * formal archive; available task attachments are copied as immutable evidence.
 */
export async function archiveTaskDeliverable({
  teamName,
  task,
  approvedAt = new Date(),
  teamDir = teamRoot(teamName),
}: ArchiveTaskDeliverableOptions): Promise<ArchivedTaskDeliverable> {
  const delivery = task.deliveries?.at(-1);
  const result = delivery?.result.trim();
  if (!delivery || !result) {
    throw new Error('Task has no deliverable result to archive');
  }

  const taskFolder = `${safePathSegment(task.id, 'task')}-${safePathSegment(task.title, 'result')}`;
  const outputDir = path.join(teamDir, 'outputs', taskFolder);
  const versionId = versionIdFor(approvedAt);
  const versionDir = path.join(outputDir, 'versions', versionId);
  const resultPath = path.join(versionDir, 'result.md');
  const manifestPath = path.join(outputDir, 'manifest.json');
  await mkdir(versionDir, { recursive: true, mode: 0o700 });
  await writeFile(resultPath, `${result}\n`, { encoding: 'utf8', mode: 0o600 });

  const archivedAttachments: string[] = [];
  if (task.attachments?.length) {
    const attachmentDir = path.join(versionDir, 'attachments');
    await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
    const copied = await Promise.all(
      task.attachments.map(async (attachment, index) => {
        const sourcePath = path.join(
          teamDir,
          'tasks',
          'attachments',
          task.id,
          `${attachment.id}.data`
        );
        const filename = `${String(index + 1).padStart(2, '0')}-${safePathSegment(
          attachment.filename,
          attachment.id
        )}${path.extname(attachment.filename) ? '' : attachmentExtension(attachment.mimeType)}`;
        const relativePath = path.join('attachments', filename);
        try {
          await copyFile(sourcePath, path.join(versionDir, relativePath));
          return relativePath;
        } catch {
          return null;
        }
      })
    );
    archivedAttachments.push(...copied.filter((item): item is string => item !== null));
  }

  const previous = await readManifest(manifestPath);
  const version: DeliverableVersion = {
    id: versionId,
    createdAt: approvedAt.toISOString(),
    deliveryVersion: delivery.version,
    resultFile: path.relative(outputDir, resultPath),
    attachments: archivedAttachments,
  };
  const manifest: DeliverableManifest = {
    schemaVersion: 1,
    taskId: task.id,
    title: task.title,
    assistant: task.assignee,
    currentVersion: versionId,
    approvedAt: approvedAt.toISOString(),
    versions: [...(previous?.versions ?? []).filter((item) => item.id !== versionId), version],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { outputDir, versionDir, versionId, resultPath, manifestPath };
}

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Task } from './TeamWorkspaceService';

function safeFilename(filename: string, fallback: string): string {
  const normalized = path
    .basename(filename)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .trim();
  return normalized || fallback;
}

function reserveUniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let index = 2;
  let candidate = `${stem}-${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function resolveInputDirectory(workDir: string, taskId: string): string {
  const projectRoot = path.resolve(workDir);
  const safeTaskId = safeFilename(taskId, 'task');
  const inputDirectory = path.resolve(projectRoot, 'input', safeTaskId);
  if (!inputDirectory.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error('任务输入目录超出当前项目范围');
  }
  return inputDirectory;
}

export interface MaterializedTaskInput {
  filename: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * Copy persisted task attachments into the target digital employee's current
 * project so runtime tools can read them as ordinary local input files.
 */
export async function materializeTaskInputs(
  task: Pick<Task, 'id' | 'attachments'>,
  workDir: string
): Promise<MaterializedTaskInput[]> {
  const attachments = task.attachments ?? [];
  if (attachments.length === 0) return [];
  const inputDirectory = resolveInputDirectory(workDir, task.id);
  await fs.mkdir(inputDirectory, { recursive: true });

  const usedFilenames = new Set<string>();
  const entries = attachments.flatMap((attachment) =>
    attachment.filePath
      ? [
          {
            attachment,
            sourcePath: attachment.filePath,
            filename: reserveUniqueFilename(
              safeFilename(attachment.filename, attachment.id),
              usedFilenames
            ),
          },
        ]
      : []
  );
  const materialized = await Promise.all(
    entries.map(async ({ attachment, sourcePath, filename }): Promise<MaterializedTaskInput> => {
      const targetPath = path.resolve(inputDirectory, filename);
      if (!targetPath.startsWith(`${inputDirectory}${path.sep}`)) {
        throw new Error('任务输入文件超出任务目录范围');
      }
      await fs.copyFile(sourcePath, targetPath);
      return {
        filename,
        path: targetPath,
        mimeType: attachment.mimeType,
        size: attachment.size,
      };
    })
  );
  await fs.writeFile(
    path.resolve(inputDirectory, 'manifest.json'),
    `${JSON.stringify({ taskId: task.id, files: materialized }, null, 2)}\n`,
    'utf8'
  );
  return materialized;
}

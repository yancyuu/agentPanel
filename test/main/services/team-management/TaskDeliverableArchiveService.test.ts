import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { archiveTaskDeliverable } from '@main/services/team-management/TaskDeliverableArchiveService';

import type { Task } from '@main/services/team-management/TeamWorkspaceService';

const tempDirs: string[] = [];

async function tempTeamDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentcli-deliverable-'));
  tempDirs.push(dir);
  return dir;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-123',
    teamSlug: 'assistant-a',
    title: '亚马逊开店流程调研',
    status: 'done',
    assignee: '调研助手',
    reviewState: 'review',
    result: '# 调研报告\n\n这是最终结论。',
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: '2026-07-30T09:00:00.000Z',
    order: 0,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('archiveTaskDeliverable', () => {
  it('writes an approved deliverable under the digital employee outputs folder', async () => {
    const teamDir = await tempTeamDir();
    const archived = await archiveTaskDeliverable({
      teamName: 'assistant-a',
      teamDir,
      task: task(),
      approvedAt: new Date('2026-07-30T10:00:00.000Z'),
    });

    expect(archived.outputDir).toContain(path.join(teamDir, 'outputs', 'task-123-'));
    expect(await readFile(archived.resultPath, 'utf8')).toContain('这是最终结论');
    const manifest = JSON.parse(await readFile(archived.manifestPath, 'utf8')) as {
      taskId: string;
      title: string;
      assistant: string;
      currentVersion: string;
      versions: { id: string; resultFile: string }[];
    };
    expect(manifest).toMatchObject({
      taskId: 'task-123',
      title: '亚马逊开店流程调研',
      assistant: '调研助手',
      currentVersion: archived.versionId,
    });
    expect(manifest.versions).toEqual([
      expect.objectContaining({ id: archived.versionId, resultFile: expect.stringMatching(/result\.md$/u) }),
    ]);
  });

  it('preserves approved versions and copies available task images', async () => {
    const teamDir = await tempTeamDir();
    const attachmentDir = path.join(teamDir, 'tasks', 'attachments', 'task-123');
    await mkdir(attachmentDir, { recursive: true });
    await writeFile(path.join(attachmentDir, 'image-1.data'), Buffer.from('png-data'));
    const withImage = task({
      attachments: [
        {
          id: 'image-1',
          filename: '结果图.png',
          mimeType: 'image/png',
          size: 8,
          addedAt: '2026-07-30T09:00:00.000Z',
        },
      ],
    });

    await archiveTaskDeliverable({
      teamName: 'assistant-a',
      teamDir,
      task: withImage,
      approvedAt: new Date('2026-07-30T10:00:00.000Z'),
    });
    const second = await archiveTaskDeliverable({
      teamName: 'assistant-a',
      teamDir,
      task: { ...withImage, result: '# 调研报告 v2' },
      approvedAt: new Date('2026-07-30T11:00:00.000Z'),
    });

    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8')) as {
      versions: { id: string; attachments: string[] }[];
    };
    expect(manifest.versions).toHaveLength(2);
    const latestVersion = manifest.versions[1];
    if (!latestVersion) throw new Error('latest version missing');
    const archivedAttachment = latestVersion.attachments[0];
    if (!archivedAttachment) throw new Error('archived attachment missing');
    expect(archivedAttachment).toMatch(/结果图\.png$/u);
    expect(await readFile(path.join(second.versionDir, archivedAttachment), 'utf8')).toBe(
      'png-data'
    );
  });

  it('refuses to archive a task without a deliverable', async () => {
    await expect(
      archiveTaskDeliverable({
        teamName: 'assistant-a',
        teamDir: await tempTeamDir(),
        task: task({ result: null }),
      })
    ).rejects.toThrow('no deliverable');
  });
});

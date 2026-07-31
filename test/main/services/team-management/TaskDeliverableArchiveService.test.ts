import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { archiveTaskDeliverable } from '@main/services/team-management/TaskDeliverableArchiveService';
import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '@main/services/team-management/TeamWorkspaceService';

const roots: string[] = [];

async function tempTeamDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-deliverable-'));
  roots.push(root);
  return root;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    teamSlug: 'team-a',
    title: '季度报告',
    status: 'done',
    assignee: '研究助手',
    deliveries: [
      {
        version: 1,
        result: '# 完成结果\n\n这是正式交付内容。',
        deliveredAt: '2026-01-02T03:04:05.000Z',
      },
    ],
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    order: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('archiveTaskDeliverable', () => {
  it('writes the latest delivery and manifest under an append-only version directory', async () => {
    const teamDir = await tempTeamDir();
    const approvedAt = new Date('2026-03-04T05:06:07.000Z');

    const archived = await archiveTaskDeliverable({
      teamName: 'team-a',
      task: task(),
      approvedAt,
      teamDir,
    });

    expect(archived.outputDir).toContain(path.join('outputs', 'task-1-季度报告'));
    expect(await readFile(archived.resultPath, 'utf8')).toBe('# 完成结果\n\n这是正式交付内容。\n');
    const manifest = JSON.parse(await readFile(archived.manifestPath, 'utf8')) as {
      currentVersion: string;
      versions: Array<{ id: string; deliveryVersion: number; resultFile: string }>;
    };
    expect(manifest.currentVersion).toBe('20260304T050607Z');
    expect(manifest.versions).toEqual([
      {
        id: '20260304T050607Z',
        createdAt: '2026-03-04T05:06:07.000Z',
        deliveryVersion: 1,
        resultFile: path.join('versions', '20260304T050607Z', 'result.md'),
        attachments: [],
      },
    ]);
    expect((await stat(archived.resultPath)).mode & 0o777).toBe(0o600);
  });

  it('appends later approvals without overwriting previous versions', async () => {
    const teamDir = await tempTeamDir();
    await archiveTaskDeliverable({
      teamName: 'team-a',
      task: task(),
      approvedAt: new Date('2026-03-04T05:06:07.000Z'),
      teamDir,
    });
    const second = await archiveTaskDeliverable({
      teamName: 'team-a',
      task: task({
        deliveries: [
          ...(task().deliveries ?? []),
          {
            version: 2,
            result: '第二版结果',
            summary: '根据反馈修改',
            deliveredAt: '2026-03-05T05:06:07.000Z',
          },
        ],
      }),
      approvedAt: new Date('2026-03-05T05:06:07.000Z'),
      teamDir,
    });

    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8')) as {
      versions: Array<{ id: string; deliveryVersion: number }>;
    };
    expect(manifest.versions).toEqual([
      expect.objectContaining({ id: '20260304T050607Z', deliveryVersion: 1 }),
      expect.objectContaining({ id: '20260305T050607Z', deliveryVersion: 2 }),
    ]);
    expect(await readFile(second.resultPath, 'utf8')).toBe('第二版结果\n');
  });

  it('copies available task attachments and tolerates stale blobs', async () => {
    const teamDir = await tempTeamDir();
    const attachmentDir = path.join(teamDir, 'tasks', 'attachments', 'task-1');
    await mkdir(attachmentDir, { recursive: true });
    await writeFile(path.join(attachmentDir, 'a1.data'), 'attachment-content');

    const archived = await archiveTaskDeliverable({
      teamName: 'team-a',
      task: task({
        attachments: [
          {
            id: 'a1',
            filename: '证据.txt',
            mimeType: 'text/plain',
            size: 18,
            addedAt: '2026-03-04T05:00:00.000Z',
          },
          {
            id: 'missing',
            filename: '缺失.png',
            mimeType: 'image/png',
            size: 20,
            addedAt: '2026-03-04T05:00:00.000Z',
          },
        ],
      }),
      approvedAt: new Date('2026-03-04T05:06:07.000Z'),
      teamDir,
    });

    const manifest = JSON.parse(await readFile(archived.manifestPath, 'utf8')) as {
      versions: Array<{ attachments: string[] }>;
    };
    expect(manifest.versions[0]?.attachments).toEqual([path.join('attachments', '01-证据.txt')]);
    expect(
      await readFile(path.join(archived.versionDir, 'attachments', '01-证据.txt'), 'utf8')
    ).toBe('attachment-content');
  });

  it('rejects tasks without a delivery', async () => {
    const teamDir = await tempTeamDir();
    await expect(
      archiveTaskDeliverable({ teamName: 'team-a', task: task({ deliveries: [] }), teamDir })
    ).rejects.toThrow('no deliverable');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { materializeTaskInputs } from '@main/services/team-management/TaskInputMaterializer';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('materializeTaskInputs', () => {
  it('copies task attachments into the target project input directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpanel-task-input-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source.data');
    await fs.writeFile(source, 'customer input', 'utf8');

    const inputs = await materializeTaskInputs(
      {
        id: 'task-1',
        attachments: [
          {
            id: 'attachment-1',
            filename: '../客户需求.md',
            mimeType: 'text/plain',
            size: 14,
            addedAt: new Date().toISOString(),
            filePath: source,
          },
        ],
      },
      path.join(root, 'project')
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0].path).toContain(path.join('input', 'task-1'));
    expect(inputs[0].path).not.toContain('..');
    expect(await fs.readFile(inputs[0].path, 'utf8')).toBe('customer input');
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'project', 'input', 'task-1', 'manifest.json'), 'utf8')
    ) as { taskId: string };
    expect(manifest.taskId).toBe('task-1');
  });
});

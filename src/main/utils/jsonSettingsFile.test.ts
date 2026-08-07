import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { updateJsonObjectFile } from './jsonSettingsFile';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('updateJsonObjectFile', () => {
  it('serializes concurrent updates without dropping unrelated settings', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-settings-'));
    temporaryDirectories.push(root);
    const settingsFile = path.join(root, 'settings.json');

    await Promise.all([
      updateJsonObjectFile(settingsFile, (settings) => {
        settings.externalChannels = { ccConnect: { enabled: true } };
      }),
      updateJsonObjectFile(settingsFile, (settings) => {
        settings.taskBus = { enabled: true };
      }),
    ]);

    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      externalChannels: { ccConnect: { enabled: true } },
      taskBus: { enabled: true },
    });
  });
});

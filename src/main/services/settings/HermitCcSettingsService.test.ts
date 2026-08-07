import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HermitCcSettingsService } from './HermitCcSettingsService';

let tmpDir: string;
let settingsFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermit-cc-settings-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('HermitCcSettingsService', () => {
  it('persists Hermit-owned attachment passthrough setting without dropping existing settings', async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ taskBus: { enabled: true }, ccSettings: { attachment_send: '' } }),
      'utf8'
    );
    const service = new HermitCcSettingsService(settingsFile);

    await expect(service.patch({ attachment_send: 'off', language: 'zh-CN' })).resolves.toEqual({
      attachment_send: 'off',
    });
    await expect(service.read()).resolves.toEqual({ attachment_send: 'off' });

    const stored = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      taskBus: { enabled: true },
      ccSettings: { attachment_send: 'off' },
    });
  });

  it('rejects unsupported attachment passthrough values', async () => {
    const service = new HermitCcSettingsService(settingsFile);

    await expect(service.patch({ attachment_send: 'maybe' })).rejects.toThrow(/attachment_send/);
    await expect(service.read()).resolves.toEqual({});
  });
});

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_HERMIT_CC_SETTINGS = {
  attachment_send: '',
} as const;

const CC_SETTINGS_KEY = 'ccSettings';
const ATTACHMENT_SEND_VALUES = new Set(['', 'on', 'off']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeHermitOwnedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!hasOwn(patch, 'attachment_send')) return {};

  const value = patch.attachment_send;
  if (typeof value !== 'string' || !ATTACHMENT_SEND_VALUES.has(value)) {
    throw new Error('attachment_send must be one of: default, on, off');
  }

  return { attachment_send: value };
}

export class HermitCcSettingsService {
  constructor(private readonly settingsFile: string) {}

  async read(): Promise<Record<string, unknown>> {
    const root = await this.readRoot();
    const settings = root[CC_SETTINGS_KEY];
    return isRecord(settings) ? settings : {};
  }

  async patch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const normalizedPatch = normalizeHermitOwnedPatch(patch);
    if (Object.keys(normalizedPatch).length === 0) return this.read();

    const root = await this.readRoot();
    const current = isRecord(root[CC_SETTINGS_KEY]) ? root[CC_SETTINGS_KEY] : {};
    const next = { ...current, ...normalizedPatch };

    root[CC_SETTINGS_KEY] = next;
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fs.writeFile(this.settingsFile, `${JSON.stringify(root, null, 2)}\n`, 'utf8');

    return next;
  }

  private async readRoot(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.settingsFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }
}

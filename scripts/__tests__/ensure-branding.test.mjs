import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BRAND } from '../../bin/branding.mjs';
import { ensureBranding } from '../ensure-branding.mjs';

describe('ensureBranding', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hermit-brand-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes branding.json with DEFAULT_BRAND when missing', async () => {
    const result = ensureBranding(tmpRoot);

    expect(result.wrote).toBe(true);
    const written = JSON.parse(await readFile(path.join(tmpRoot, 'branding.json'), 'utf-8'));
    expect(written).toEqual(DEFAULT_BRAND);
  });

  it('does not overwrite an existing (customized) branding.json', async () => {
    const custom = { ...DEFAULT_BRAND, stylizedName: 'Custom', cliCommand: 'custom-cli' };
    await writeFile(path.join(tmpRoot, 'branding.json'), JSON.stringify(custom));

    const result = ensureBranding(tmpRoot);

    expect(result.wrote).toBe(false);
    const after = JSON.parse(await readFile(path.join(tmpRoot, 'branding.json'), 'utf-8'));
    expect(after.stylizedName).toBe('Custom');
    expect(after.cliCommand).toBe('custom-cli');
  });
});

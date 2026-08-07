import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import type { Config } from 'tailwindcss';

const require = createRequire(import.meta.url);
const { loadConfig } = require('tailwindcss/lib/lib/load-config.js') as {
  loadConfig(path: string): Config;
};
const projectConfig = loadConfig(path.resolve(process.cwd(), 'tailwind.config.js'));

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function lightThemeHex(css: string, variable: string): string {
  const start = css.indexOf(':root.light {');
  const end = css.indexOf('\n}', start);
  const lightBlock = css.slice(start, end);
  const declaration = lightBlock
    .split('\n')
    .find((line) => line.trimStart().startsWith(`${variable}:`));
  const match = /#[0-9a-fA-F]{6}/.exec(declaration ?? '');
  if (!match?.[0]) throw new Error(`Missing ${variable} in light theme`);
  return match[0];
}

describe('Tailwind workbench theme tokens', () => {
  it('generates opacity-aware brand and destructive utilities while preserving surface aliases', async () => {
    const config: Config = {
      ...projectConfig,
      content: [
        {
          raw: '<div class="bg-brand/10 hover:bg-brand/90 bg-destructive/90 bg-surface bg-surface-raised bg-workbench-surface bg-workbench-surface-raised"></div>',
          extension: 'html',
        },
      ],
      corePlugins: {
        preflight: false,
      },
    };

    const result = await postcss([tailwindcss(config)]).process('@tailwind utilities;', {
      from: undefined,
    });

    expect(result.css).toContain('rgb(var(--brand-rgb) / 0.1)');
    expect(result.css).toContain('rgb(var(--brand-rgb) / 0.9)');
    expect(result.css).toContain('rgb(var(--destructive-rgb) / 0.9)');
    expect(result.css).toContain('background-color: var(--color-surface)');
    expect(result.css).toContain('background-color: var(--color-surface-raised)');
    expect(result.css).toContain('background-color: var(--surface)');
    expect(result.css).toContain('background-color: var(--surface-raised)');
  });

  it('keeps muted foreground text WCAG AA compliant on light shell surfaces', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
    const mutedForeground = lightThemeHex(css, '--muted-foreground');
    const appShell = lightThemeHex(css, '--app-shell');
    const pageCanvas = lightThemeHex(css, '--page-canvas');

    expect(contrastRatio(mutedForeground, appShell)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mutedForeground, pageCanvas)).toBeGreaterThanOrEqual(4.5);
  });
});

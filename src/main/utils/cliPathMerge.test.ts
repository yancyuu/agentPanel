import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildMergedCliPath } from './cliPathMerge';

const originalHermitHome = process.env.HERMIT_HOME;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHermitHome === undefined) delete process.env.HERMIT_HOME;
  else process.env.HERMIT_HOME = originalHermitHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('buildMergedCliPath', () => {
  it('prefers the Workbench-managed Hermit bin without mutating process PATH', () => {
    const delimiter = path.delimiter;
    process.env.HERMIT_HOME = path.join(path.sep, 'tmp', 'hermit home');
    process.env.PATH = ['/global/npm/bin', '/usr/bin'].join(delimiter);

    const merged = buildMergedCliPath('/runtime/bin/claude');
    const entries = merged.split(delimiter);

    expect(entries).toContain(path.join(process.env.HERMIT_HOME, 'bin'));
    expect(entries.indexOf(path.join(process.env.HERMIT_HOME, 'bin'))).toBeLessThan(
      entries.indexOf('/global/npm/bin')
    );
    expect(process.env.PATH).toBe(['/global/npm/bin', '/usr/bin'].join(delimiter));
  });
});

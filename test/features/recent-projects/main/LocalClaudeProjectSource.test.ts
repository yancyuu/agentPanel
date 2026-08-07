import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalClaudeProjectSource } from '@features/recent-projects/main/infrastructure/LocalClaudeProjectSource';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-local-claude-projects-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalClaudeProjectSource', () => {
  it('discovers local project folders that contain .claude directories', async () => {
    const alpha = path.join(tmpDir, 'code', 'alpha');
    const beta = path.join(tmpDir, 'code', 'nested', 'beta');
    const ignored = path.join(tmpDir, 'code', 'plain');
    fs.mkdirSync(path.join(alpha, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(beta, '.claude'), { recursive: true });
    fs.mkdirSync(ignored, { recursive: true });

    const result = await new LocalClaudeProjectSource({ roots: [path.join(tmpDir, 'code')] }).list();
    const candidates = Array.isArray(result) ? result : result.candidates;

    expect(candidates.map((candidate) => candidate.primaryPath).sort()).toEqual(
      [fs.realpathSync(alpha), fs.realpathSync(beta)].sort()
    );
    const canonicalAlpha = fs.realpathSync(alpha);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: `local:${canonicalAlpha}`,
          displayName: 'alpha',
          associatedPaths: [canonicalAlpha],
          providerIds: ['anthropic'],
          sourceKind: 'claude',
          openTarget: { type: 'synthetic-path', path: canonicalAlpha },
        }),
      ])
    );
  });

  it('keeps scanning sibling projects while skipping heavy generated folders', async () => {
    const sourceRoot = path.join(tmpDir, 'workspace');
    const generatedProject = path.join(sourceRoot, 'node_modules', 'generated');
    const realProject = path.join(sourceRoot, 'real-project');
    fs.mkdirSync(path.join(generatedProject, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(realProject, '.claude'), { recursive: true });

    const result = await new LocalClaudeProjectSource({ roots: [sourceRoot] }).list();
    const candidates = Array.isArray(result) ? result : result.candidates;

    expect(candidates.map((candidate) => candidate.primaryPath)).toEqual([fs.realpathSync(realProject)]);
  });
});

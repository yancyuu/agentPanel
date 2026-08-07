import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGlobalWorkflows,
  getHermitWorkflowScanDir,
  migrateLegacyWorkflowFolder,
  scanHermitWorkflows,
} from '@main/services/system-manager/BuiltinWorkflowSeeder';

let tmpDir: string;
let originalHermitHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-builtin-workflows-'));
  originalHermitHome = process.env.HERMIT_HOME;
  process.env.HERMIT_HOME = tmpDir;
});

afterEach(() => {
  process.env.HERMIT_HOME = originalHermitHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BuiltinWorkflowSeeder', () => {
  it('seeds every bundled workflow file into ~/.hermit/.claude/workflow/', async () => {
    const bundledDir = path.resolve(process.cwd(), 'src/main/services/system-manager/builtin-workflows');
    const bundledFiles = fs
      .readdirSync(bundledDir)
      .filter((name) => name.endsWith('.md') || name.endsWith('.js'))
      .sort();

    await ensureGlobalWorkflows();
    const scanDir = getHermitWorkflowScanDir();

    const workflows = await scanHermitWorkflows(scanDir);
    expect(workflows.map((workflow) => workflow.filename).sort()).toEqual(bundledFiles);
    for (const filename of bundledFiles) {
      expect(fs.readFileSync(path.join(scanDir, filename), 'utf8')).toContain(
        'hermit-builtin-workflow:v2-loop'
      );
    }
    for (const filename of bundledFiles.filter((name) => name.endsWith('.js'))) {
      expect(workflows).toContainEqual(
        expect.objectContaining({
          id: path.basename(filename, '.js'),
          filename,
          content: expect.stringContaining('export const meta'),
        })
      );
    }
  });

  it('seeds the create-team workflow that provisions a team via the HTTP API', async () => {
    await ensureGlobalWorkflows();
    const content = fs.readFileSync(path.join(getHermitWorkflowScanDir(), 'create-team.md'), 'utf8');

    expect(content).toContain('hermit-builtin-workflow:v2-loop');
    expect(content).toContain('/api/teams/create');
    expect(content).toContain('${HERMIT_API_URL:-http://127.0.0.1:5680}');
    expect(content).toContain('^[a-z0-9][a-z0-9_-]*$');
    expect(content).toMatch(/不自动启动|不要.*启动.*agent/);
  });

  it('refreshes managed workflow files when bundled content changes', async () => {
    const scanDir = getHermitWorkflowScanDir();
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(
      path.join(scanDir, 'doctor.md'),
      '<!-- hermit-builtin-workflow:v2-loop -->\n# Stale Doctor\n',
      'utf8'
    );

    await ensureGlobalWorkflows();

    const content = fs.readFileSync(path.join(scanDir, 'doctor.md'), 'utf8');
    expect(content).toContain('# Loop Runtime Doctor');
    expect(content).not.toContain('# Stale Doctor');
  });

  it('does not overwrite user-edited workflow files', async () => {
    const scanDir = getHermitWorkflowScanDir();
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'doctor.md'), '# Custom Doctor\n', 'utf8');

    await ensureGlobalWorkflows();

    expect(fs.readFileSync(path.join(scanDir, 'doctor.md'), 'utf8')).toBe('# Custom Doctor\n');
  });

  it('moves legacy workspace workflows into native .claude/commands without a second live source', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const legacyDir = path.join(workspaceDir, 'workflows');
    const commandDir = path.join(workspaceDir, '.claude', 'commands');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'nightly-triage.md'), '# Nightly Triage\n', 'utf8');

    const moved = await migrateLegacyWorkflowFolder(workspaceDir);

    expect(moved).toBe(1);
    expect(fs.existsSync(path.join(commandDir, 'nightly-triage.md'))).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it('renames conflicting legacy workflows while still removing the legacy folder', async () => {
    const workspaceDir = path.join(tmpDir, 'conflict-workspace');
    const legacyDir = path.join(workspaceDir, 'workflows');
    const commandDir = path.join(workspaceDir, '.claude', 'commands');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'doctor.md'), '# Legacy Doctor\n', 'utf8');
    fs.writeFileSync(path.join(commandDir, 'doctor.md'), '# Current Doctor\n', 'utf8');

    const moved = await migrateLegacyWorkflowFolder(workspaceDir);

    expect(moved).toBe(1);
    expect(fs.readFileSync(path.join(commandDir, 'doctor.md'), 'utf8')).toBe('# Current Doctor\n');
    expect(fs.readFileSync(path.join(commandDir, 'doctor.legacy-workflow.md'), 'utf8')).toBe(
      '# Legacy Doctor\n'
    );
    expect(fs.existsSync(legacyDir)).toBe(false);
  });
});

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../..');
const postinstallPath = path.join(repoRoot, 'bin/postinstall.mjs');
const bundledWorkflowsDir = path.join(repoRoot, 'src/main/services/system-manager/builtin-workflows');
const workflowMarker = '<!-- hermit-builtin-workflow:v2-loop -->';

let hermitHome: string;

function bundledWorkflowFiles(): string[] {
  return fs
    .readdirSync(bundledWorkflowsDir)
    .filter((name) => name.endsWith('.md') || name.endsWith('.js'))
    .sort();
}

function firstBundledDynamicWorkflow(): string {
  const filename = bundledWorkflowFiles().find((name) => name.endsWith('.js'));
  if (!filename) throw new Error('Expected at least one bundled dynamic workflow');
  return filename;
}

async function runPostinstall() {
  return execFileAsync(process.execPath, [postinstallPath], {
    cwd: repoRoot,
    env: { ...process.env, HERMIT_HOME: hermitHome },
  });
}

beforeEach(() => {
  hermitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openhermit-postinstall-'));
});

afterEach(() => {
  fs.rmSync(hermitHome, { recursive: true, force: true });
});

describe('AgentCLI postinstall', () => {
  it('installs every bundled workflow into HERMIT_HOME/.claude/workflow', async () => {
    const { stdout } = await runPostinstall();
    const targetDir = path.join(hermitHome, '.claude/workflow');
    const files = fs.readdirSync(targetDir).filter((name) => name.endsWith('.md') || name.endsWith('.js')).sort();

    expect(files).toEqual(bundledWorkflowFiles());
    expect(stdout).toContain('[AgentCLI] Installed');
    expect(stdout).toContain('workflow(s)');
    for (const filename of files) {
      expect(fs.readFileSync(path.join(targetDir, filename), 'utf8')).toContain('hermit-builtin-workflow:v2-loop');
    }
  });

  it('does not overwrite user-managed workflow files without the builtin marker', async () => {
    const targetDir = path.join(hermitHome, '.claude/workflow');
    fs.mkdirSync(targetDir, { recursive: true });
    const dynamicWorkflow = firstBundledDynamicWorkflow();
    fs.writeFileSync(path.join(targetDir, dynamicWorkflow), 'export const meta = { name: "custom" }\n', 'utf8');

    const { stdout } = await runPostinstall();

    expect(fs.readFileSync(path.join(targetDir, dynamicWorkflow), 'utf8')).toBe(
      'export const meta = { name: "custom" }\n'
    );
    expect(stdout).toContain('skipped 1 user-managed file(s)');
  });

  it('refreshes managed workflow files that contain the builtin marker', async () => {
    const targetDir = path.join(hermitHome, '.claude/workflow');
    fs.mkdirSync(targetDir, { recursive: true });
    const dynamicWorkflow = firstBundledDynamicWorkflow();
    fs.writeFileSync(
      path.join(targetDir, dynamicWorkflow),
      `// ${workflowMarker}\nexport const meta = { name: 'stale' }\n`,
      'utf8'
    );

    await runPostinstall();

    const content = fs.readFileSync(path.join(targetDir, dynamicWorkflow), 'utf8');
    expect(content).toBe(fs.readFileSync(path.join(bundledWorkflowsDir, dynamicWorkflow), 'utf8'));
    expect(content).not.toContain("name: 'stale'");
  });
});

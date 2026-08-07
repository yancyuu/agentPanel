import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowPromptService } from '@main/services/system-manager/WorkflowPromptService';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-workflow-prompts-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WorkflowPromptService', () => {
  it('lists nested Claude command folders as namespaced slash commands', async () => {
    const hermitDir = path.join(tmpDir, '.claude', 'commands', 'hermit');
    fs.mkdirSync(hermitDir, { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'daily-workflow-extraction.md'), '# Daily Workflow Extraction\n', 'utf8');

    const result = await new WorkflowPromptService().list(hermitDir);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]).toMatchObject({
      filename: 'daily-workflow-extraction.md',
      source: 'claude-command',
      commandName: '/hermit:daily-workflow-extraction',
    });
  });

  it('lists workspace root Claude command folders using native slash command names', async () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(path.join(commandsDir, 'ops'), { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'nightly-triage.md'), '# Triage\n', 'utf8');
    fs.writeFileSync(path.join(commandsDir, 'ops', 'summary.md'), '# Summary\n', 'utf8');

    const result = await new WorkflowPromptService().list(commandsDir);

    expect(result.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'nightly-triage.md',
          source: 'claude-command',
          commandName: '/nightly-triage',
        }),
        expect.objectContaining({
          filename: path.join('ops', 'summary.md'),
          source: 'claude-command',
          commandName: '/ops:summary',
        }),
      ])
    );
  });

  it('reads descriptions and ordering from Claude command frontmatter', async () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'doctor.md'),
      [
        '---',
        'id: "doctor"',
        'label: "Doctor"',
        'description: "诊断 Hermit、Claude Code 和 Loop runtime 健康。"',
        'category: health',
        'safety: read-only',
        'order: 20',
        '---',
        '# Loop Runtime Doctor',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await new WorkflowPromptService().list(commandsDir);

    expect(result.prompts[0]).toMatchObject({
      id: 'doctor',
      label: 'Doctor',
      description: '诊断 Hermit、Claude Code 和 Loop runtime 健康。',
      category: 'health',
      safety: 'read-only',
      order: 20,
      commandName: '/doctor',
    });
  });

  it('supports desc as a frontmatter alias for command descriptions', async () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'summary.md'),
      ['---', 'desc: 汇总团队状态和下一步建议', '---', '# Summary', ''].join('\n'),
      'utf8'
    );

    const result = await new WorkflowPromptService().list(commandsDir);

    expect(result.prompts[0]).toMatchObject({
      description: '汇总团队状态和下一步建议',
      commandName: '/summary',
    });
  });

  it('rejects legacy workflow folders so command boards only use native Claude commands', async () => {
    const workflowsDir = path.join(tmpDir, 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, 'nightly-triage.md'), '# Triage\n', 'utf8');

    await expect(new WorkflowPromptService().list(workflowsDir)).rejects.toThrow(/\.claude\/commands/);
  });
});

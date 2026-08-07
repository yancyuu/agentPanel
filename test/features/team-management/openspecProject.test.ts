import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ASSET_BLOCK_BEGIN,
  ASSET_BLOCK_END,
  ensureOpenspecProject,
  removeAssetInstructionBlocks,
} from '@main/services/team-management/openspecProject';
import { ensureOpenspecWrapperCommand } from '@main/services/team-management/openspecRuntime';

let tmpDir: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-project-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe('ensureOpenspecProject', () => {
  it('创建标准骨架并注入 AGENTS.md 托管块与 CLAUDE.md 指针', async () => {
    const workDir = path.join(tmpDir, 'team-a');
    await ensureOpenspecProject(workDir, '/home/u/.hermit/bin/openspec', {
      pointerFile: 'CLAUDE.md',
    });

    for (const dir of ['specs', 'changes']) {
      expect(fs.existsSync(path.join(workDir, 'openspec', dir))).toBe(true);
    }
    // 归档目录由 CLI 在首次 archive 时创建（openspec/changes/archive），骨架不预建
    expect(fs.existsSync(path.join(workDir, 'openspec', 'archive'))).toBe(false);
    expect(fs.readFileSync(path.join(workDir, 'openspec', 'config.yaml'), 'utf8')).toContain(
      'schema: spec-driven'
    );

    const agents = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(ASSET_BLOCK_BEGIN);
    expect(agents).toContain(ASSET_BLOCK_END);
    expect(agents).toContain('产物沉淀');
    expect(agents).toContain('/home/u/.hermit/bin/openspec new change');
    expect(agents).toContain('workflow');
    expect(agents).toContain('behavior-contract');
    expect(agents).toContain('Trigger');
    expect(agents).toContain('checkpoint');
    expect(agents).toContain('开工先读产物');
    // 页面/设计类交付物指引（delivery-html-preview）
    expect(agents).toContain('自包含 HTML');
    expect(agents).toContain('内联样式');

    const claude = fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('AGENTS.md');
    expect(claude).not.toContain('沉淀命令序列');
  });

  it('幂等：不覆盖已有 openspec 内容，托管块不重复', async () => {
    const workDir = path.join(tmpDir, 'team-b');
    await ensureOpenspecProject(workDir, '/bin/openspec');

    // 用户已有内容
    fs.writeFileSync(path.join(workDir, 'openspec', 'config.yaml'), 'schema: custom\n');
    fs.mkdirSync(path.join(workDir, 'openspec', 'specs', 'weekly-report'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'openspec', 'specs', 'weekly-report', 'spec.md'), '# 周报\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '# 我的团队约定\n\n保持这一行。\n');

    await ensureOpenspecProject(workDir, '/bin/openspec');
    await ensureOpenspecProject(workDir, '/bin/openspec');

    expect(fs.readFileSync(path.join(workDir, 'openspec', 'config.yaml'), 'utf8')).toBe(
      'schema: custom\n'
    );
    expect(
      fs.existsSync(path.join(workDir, 'openspec', 'specs', 'weekly-report', 'spec.md'))
    ).toBe(true);

    const agents = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('保持这一行。');
    expect(agents.match(new RegExp(ASSET_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('removeAssetInstructionBlocks 只移除托管块', async () => {
    const workDir = path.join(tmpDir, 'team-c');
    await ensureOpenspecProject(workDir, '/bin/openspec');
    await removeAssetInstructionBlocks(workDir);

    const agents = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain(ASSET_BLOCK_BEGIN);
    expect(fs.existsSync(path.join(workDir, 'openspec', 'specs'))).toBe(true);
  });
});

describe('ensureOpenspecWrapperCommand', () => {
  it('生成指向 vendor CLI 的包装脚本（幂等）', () => {
    const cliEntry = path.join(tmpDir, 'vendor', 'openspec', 'bin', 'openspec.js');
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
    fs.writeFileSync(cliEntry, '#!/usr/bin/env node\n');
    process.env.AGENTPANEL_OPENSPEC_CLI = cliEntry;

    const hermitHome = path.join(tmpDir, 'hermit');
    const wrapper = ensureOpenspecWrapperCommand(hermitHome);
    expect(wrapper).toBe(path.join(hermitHome, 'bin', 'openspec'));

    const content = fs.readFileSync(wrapper!, 'utf8');
    expect(content).toContain(cliEntry);
    expect(content).toContain('exec');
    expect(fs.existsSync(`${wrapper}.cmd`)).toBe(true);
    // 可执行位
    expect(() => fs.accessSync(wrapper!, fs.constants.X_OK)).not.toThrow();

    // 幂等：再次调用不报错
    expect(ensureOpenspecWrapperCommand(hermitHome)).toBe(wrapper);
  });

  it('显式入口缺失时回退到 AGENTPANEL_PACKAGE_ROOT 的 vendor', () => {
    delete process.env.AGENTPANEL_OPENSPEC_CLI;
    const packageRoot = path.join(tmpDir, 'pkg');
    const cliEntry = path.join(packageRoot, 'vendor', 'openspec', 'bin', 'openspec.js');
    fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
    fs.writeFileSync(cliEntry, '#!/usr/bin/env node\n');
    process.env.AGENTPANEL_PACKAGE_ROOT = packageRoot;

    const wrapper = ensureOpenspecWrapperCommand(path.join(tmpDir, 'hermit3'));
    expect(wrapper).not.toBeNull();
    expect(fs.readFileSync(wrapper!, 'utf8')).toContain(cliEntry);
  });
});

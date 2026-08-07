import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamAssetRoutes } from '../../../src/main/routes/teamAssetRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
const tempDirs: string[] = [];

async function makeWorkDir(layout: 'empty' | 'with-assets'): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-assets-test-'));
  tempDirs.push(workDir);
  if (layout === 'with-assets') {
    const specDir = path.join(workDir, 'openspec', 'specs', 'weekly-report');
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, 'spec.md'), '# 周报生成工作流\n\n## Purpose\n\n生成周报。\n');

    const changeDir = path.join(workDir, 'openspec', 'changes', 'archive', '2026-08-01-add-weekly-report');
    const deltaDir = path.join(changeDir, 'specs', 'weekly-report');
    await fs.mkdir(deltaDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Proposal: 周报\n');
    await fs.writeFile(
      path.join(deltaDir, 'spec.md'),
      '## ADDED Requirements\n\n### Requirement: 周报\n\n## MODIFIED Requirements\n'
    );
  }
  return workDir;
}

function createHarness(overrides: {
  workDir?: string;
  deletedAt?: string;
  ensureAssetsProject?: (workDir: string, harness?: string) => Promise<void>;
}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerTeamAssetRoutes(app, {
    readTeamManifest: vi.fn(async () => ({
      slug: 'team-a',
      workDir: overrides.workDir,
      deletedAt: overrides.deletedAt,
    })),
    ensureAssetsProject: overrides.ensureAssetsProject,
    reply500: (error) => ({ ok: false as const, error: String(error) }),
  });
  return { app };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GET /api/teams/:name/assets', () => {
  it('解析 living specs（标题/更新时间）与沉淀记录（操作类型）', async () => {
    const workDir = await makeWorkDir('with-assets');
    const { app } = createHarness({ workDir });

    const response = await app.inject({ method: 'GET', url: '/api/teams/team-a/assets' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.specs).toEqual([
      expect.objectContaining({ id: 'weekly-report', title: '周报生成工作流' }),
    ]);
    expect(body.specs[0].updatedAt).toBeTruthy();
    expect(body.archives).toEqual([
      expect.objectContaining({
        id: '2026-08-01-add-weekly-report',
        operations: expect.arrayContaining(['ADDED', 'MODIFIED']),
      }),
    ]);
    expect(body.archives[0].archivedAt).toBeTruthy();
  });

  it('空产物库返回空列表并触发存量补建', async () => {
    const workDir = await makeWorkDir('empty');
    const ensureAssetsProject = vi.fn(async () => undefined);
    const { app } = createHarness({ workDir, ensureAssetsProject });

    const response = await app.inject({ method: 'GET', url: '/api/teams/team-a/assets' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, specs: [], archives: [] });
    // 存量团队幂等补建
    expect(ensureAssetsProject).toHaveBeenCalledWith(workDir, undefined);
  });

  it('团队不存在或已删除时返回 404', async () => {
    const { app } = createHarness({ workDir: undefined });
    const missing = await app.inject({ method: 'GET', url: '/api/teams/team-a/assets' });
    expect(missing.statusCode).toBe(404);

    const { app: deletedApp } = createHarness({
      workDir: '/tmp/x',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    const deleted = await deletedApp.inject({ method: 'GET', url: '/api/teams/team-a/assets' });
    expect(deleted.statusCode).toBe(404);
  });
});

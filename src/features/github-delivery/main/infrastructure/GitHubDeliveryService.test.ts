import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitHubDeliveryService } from './GitHubDeliveryService';

const temporaryDirectories: string[] = [];

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeArchivedDeliverable({
  teamDir,
  taskId,
  versionId,
  manifestVersionId = versionId,
  outputName = `${taskId}-result`,
  approvedAt = '2026-01-01T00:00:00.000Z',
}: {
  teamDir: string;
  taskId: string;
  versionId: string;
  manifestVersionId?: string;
  outputName?: string;
  approvedAt?: string;
}): void {
  const outputDir = path.join(teamDir, 'outputs', outputName);
  const versionDir = path.join(outputDir, 'versions', versionId);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(versionDir, 'result.md'), `# ${taskId}\n`);
  writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      taskId,
      title: `${taskId} result`,
      currentVersion: manifestVersionId,
      ...(approvedAt ? { approvedAt } : {}),
      versions: [{ id: versionId, resultFile: `versions/${versionId}/result.md` }],
    })
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitHubDeliveryService bindings', () => {
  it('normalizes a GitHub SSH repository and persists a delivery-only binding', async () => {
    const hermitHome = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(hermitHome);
    const service = new GitHubDeliveryService(hermitHome);

    await expect(
      service.saveBinding('研究助手', {
        repository: 'git@github.com:example/deliverables.git',
        branch: 'agent/research',
      })
    ).resolves.toMatchObject({
      agentName: '研究助手',
      repository: 'example/deliverables',
      branch: 'agent/research',
      transport: 'ssh',
    });
    await expect(service.listBindings()).resolves.toHaveLength(1);
    expect(
      JSON.parse(readFileSync(path.join(hermitHome, 'github-delivery.json'), 'utf8'))
    ).toMatchObject({
      schemaVersion: 1,
      bindings: { 研究助手: { repository: 'example/deliverables', transport: 'ssh' } },
    });
    await service.deleteBinding('研究助手');
    await expect(service.listBindings()).resolves.toEqual([]);
  });

  it('rejects a non-GitHub destination before persisting any credential-like URL', async () => {
    const hermitHome = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(hermitHome);
    const service = new GitHubDeliveryService(hermitHome);

    await expect(
      service.saveBinding('writer', { repository: 'https://example.invalid/not-github' })
    ).rejects.toThrow('仓库必须是 GitHub');
  });

  it('rejects manifests that point outside approved version directories', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(root);
    const teamDir = path.join(root, 'team');
    writeArchivedDeliverable({
      teamDir,
      taskId: 'task-1',
      versionId: 'approved-v1',
      manifestVersionId: '../../unapproved',
    });
    const service = new GitHubDeliveryService(path.join(root, 'home'), {
      teamRootFor: () => teamDir,
    });

    await expect(service.resolveArchivedVersion('team', 'task-1')).rejects.toThrow(
      '未找到该任务已批准的交付成果'
    );
  });

  it('rejects a symlinked versions directory that escapes the approved output', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(root);
    const teamDir = path.join(root, 'team');
    const taskId = 'task-1';
    writeArchivedDeliverable({ teamDir, taskId, versionId: 'v1' });
    const outputDir = path.join(teamDir, 'outputs', `${taskId}-result`);
    const externalVersions = path.join(root, 'external-versions');
    mkdirSync(path.join(externalVersions, 'v1'), { recursive: true });
    writeFileSync(path.join(externalVersions, 'v1', 'result.md'), '# outside\n');
    rmSync(path.join(outputDir, 'versions'), { recursive: true, force: true });
    symlinkSync(externalVersions, path.join(outputDir, 'versions'), 'dir');
    const service = new GitHubDeliveryService(path.join(root, 'home'), {
      teamRootFor: () => teamDir,
    });

    await expect(service.resolveArchivedVersion('team', taskId)).rejects.toThrow(
      '已批准成果版本路径无效'
    );
  });

  it('chooses the most recently approved archive when a renamed task has multiple outputs', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(root);
    const teamDir = path.join(root, 'team');
    writeArchivedDeliverable({
      teamDir,
      taskId: 'task-1',
      versionId: 'old-v1',
      outputName: 'task-1-old-title',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    writeArchivedDeliverable({
      teamDir,
      taskId: 'task-1',
      versionId: 'new-v2',
      outputName: 'task-1-new-title',
      approvedAt: '2026-02-01T00:00:00.000Z',
    });
    const service = new GitHubDeliveryService(path.join(root, 'home'), {
      teamRootFor: () => teamDir,
    });

    await expect(service.resolveArchivedVersion('team', 'task-1')).resolves.toMatchObject({
      versionId: 'new-v2',
      outputDir: expect.stringContaining('task-1-new-title'),
    });
  });

  it('rejects archive manifests without approval metadata', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(root);
    const teamDir = path.join(root, 'team');
    writeArchivedDeliverable({ teamDir, taskId: 'task-1', versionId: 'v1', approvedAt: '' });
    const service = new GitHubDeliveryService(path.join(root, 'home'), {
      teamRootFor: () => teamDir,
    });

    await expect(service.resolveArchivedVersion('team', 'task-1')).rejects.toThrow(
      '未找到该任务已批准的交付成果'
    );
  });

  it('preserves an existing delivery branch across repeat publishes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    temporaryDirectories.push(root);
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const teamDir = path.join(root, 'team');
    git(['init', '--bare', remote]);
    git(['init', seed]);
    writeFileSync(path.join(seed, 'README.md'), '# delivery target\n');
    git(['add', 'README.md'], seed);
    git(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'],
      seed
    );
    git(['branch', '-M', 'main'], seed);
    git(['remote', 'add', 'origin', remote], seed);
    git(['push', 'origin', 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

    writeArchivedDeliverable({ teamDir, taskId: 'task-one', versionId: 'v1' });
    writeArchivedDeliverable({ teamDir, taskId: 'task-two', versionId: 'v2' });
    const service = new GitHubDeliveryService(path.join(root, 'home'), {
      teamRootFor: () => teamDir,
      remoteUrlFor: () => remote,
    });
    await service.saveBinding('writer', { repository: 'example/deliverables' });

    await expect(
      service.publish({ teamName: 'team', taskId: 'task-one', agentName: 'writer' })
    ).resolves.toMatchObject({ branch: 'agentpanel-deliveries' });
    await expect(
      service.publish({ teamName: 'team', taskId: 'task-two', agentName: 'writer' })
    ).resolves.toMatchObject({ branch: 'agentpanel-deliveries' });

    const verification = path.join(root, 'verification');
    git(['clone', '--branch', 'agentpanel-deliveries', remote, verification]);
    expect(
      readFileSync(
        path.join(verification, 'deliveries', 'team', 'task-one', 'v1', 'result.md'),
        'utf8'
      )
    ).toContain('task-one');
    expect(
      readFileSync(
        path.join(verification, 'deliveries', 'team', 'task-two', 'v2', 'result.md'),
        'utf8'
      )
    ).toContain('task-two');
  });
});

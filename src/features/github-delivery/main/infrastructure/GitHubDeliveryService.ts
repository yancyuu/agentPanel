import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { teamRoot } from '@main/services/team-management/TeamWorkspaceService';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';

import type {
  GitHubDeliveryBinding,
  GitHubDeliveryReceipt,
  GitHubDeliveryTransport,
  SaveGitHubDeliveryBindingRequest,
} from '../../contracts';
import type { Dirent } from 'node:fs';

const executeFile = promisify(execFile);
const logger = createLogger('GitHubDeliveryService');
const DEFAULT_BRANCH = 'agentpanel-deliveries';

interface DeliveryManifest {
  schemaVersion: 1;
  taskId: string;
  title: string;
  assistant?: string | null;
  currentVersion: string;
  approvedAt: string;
  versions: { id: string; resultFile: string }[];
}

interface BindingStore {
  schemaVersion: 1;
  bindings: Record<string, GitHubDeliveryBinding>;
}

interface GitHubDeliveryServiceOptions {
  /** Test seam; production always resolves to the normal team workspace. */
  teamRootFor?: (teamName: string) => string;
  /** Test seam; production returns a credential-free github.com remote URL. */
  remoteUrlFor?: (binding: GitHubDeliveryBinding) => string;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return normalized || fallback;
}

function normalizeRepository(value: string): {
  repository: string;
  transport: GitHubDeliveryTransport;
} {
  const trimmed = value.trim().replace(/\/$/u, '');
  const httpsMatch = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(trimmed);
  const sshMatch = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(trimmed);
  const shortMatch = /^([\w.-]+)\/([\w.-]+)$/u.exec(trimmed);
  const match = httpsMatch ?? sshMatch ?? shortMatch;
  if (!match) throw new Error('仓库必须是 GitHub owner/repository、HTTPS URL 或 SSH URL');
  return {
    repository: `${match[1]}/${match[2]}`,
    transport: sshMatch ? 'ssh' : 'https',
  };
}

function toRemoteUrl(repository: string, transport: GitHubDeliveryTransport): string {
  return transport === 'ssh'
    ? `git@github.com:${repository}.git`
    : `https://github.com/${repository}.git`;
}

function isSafeVersionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    !value.includes('..')
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function approvedAtTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function assertBranch(value: string): string {
  const branch = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/u.test(branch) || branch.includes('..')) {
    throw new Error('分支名称无效');
  }
  return branch;
}

async function readBindingStore(filePath: string): Promise<BindingStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
      (parsed as { bindings?: unknown }).bindings &&
      typeof (parsed as { bindings: unknown }).bindings === 'object'
    ) {
      return parsed as BindingStore;
    }
  } catch {
    // No binding has been saved yet.
  }
  return { schemaVersion: 1, bindings: {} };
}

async function findArchivedDeliverable(
  teamName: string,
  taskId: string,
  teamRootFor: (teamName: string) => string
): Promise<{ outputDir: string; manifest: DeliveryManifest }> {
  const outputRoot = path.join(teamRootFor(teamName), 'outputs');
  let entries: Dirent[];
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch {
    throw new Error('任务尚未归档为可交付成果');
  }
  const candidates: Array<{ outputDir: string; manifest: DeliveryManifest; approvedAt: number }> =
    [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const outputDir = path.join(outputRoot, entry.name);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(outputDir, 'manifest.json'), 'utf8')
      ) as DeliveryManifest;
      const approvedAt = approvedAtTimestamp(manifest.approvedAt);
      const currentVersion = manifest.versions?.find(
        (version) => version && version.id === manifest.currentVersion
      );
      if (
        manifest.schemaVersion === 1 &&
        manifest.taskId === taskId &&
        typeof manifest.title === 'string' &&
        manifest.title.trim() &&
        approvedAt !== null &&
        isSafeVersionId(manifest.currentVersion) &&
        typeof currentVersion?.resultFile === 'string' &&
        currentVersion.resultFile.trim()
      ) {
        candidates.push({ outputDir, manifest, approvedAt });
      }
    } catch {
      // Ignore incomplete or unrelated directories.
    }
  }
  candidates.sort(
    (left, right) =>
      right.approvedAt - left.approvedAt || right.outputDir.localeCompare(left.outputDir)
  );
  const latest = candidates[0];
  if (!latest) throw new Error('未找到该任务已批准的交付成果');
  return latest;
}

export class GitHubDeliveryService {
  private readonly bindingFile: string;
  private readonly teamRootFor: (teamName: string) => string;
  private readonly remoteUrlFor: (binding: GitHubDeliveryBinding) => string;

  constructor(hermitHome: string, options: GitHubDeliveryServiceOptions = {}) {
    this.bindingFile = path.join(hermitHome, 'github-delivery.json');
    this.teamRootFor = options.teamRootFor ?? teamRoot;
    this.remoteUrlFor =
      options.remoteUrlFor ?? ((binding) => toRemoteUrl(binding.repository, binding.transport));
  }

  async listBindings(): Promise<GitHubDeliveryBinding[]> {
    const store = await readBindingStore(this.bindingFile);
    return Object.values(store.bindings)
      .map(
        (binding): GitHubDeliveryBinding => ({
          ...binding,
          transport: binding.transport === 'ssh' ? 'ssh' : 'https',
        })
      )
      .sort((left, right) => left.agentName.localeCompare(right.agentName));
  }

  async deleteBinding(agentName: string): Promise<void> {
    const normalizedAgentName = agentName.trim();
    if (!normalizedAgentName || normalizedAgentName.length > 120) throw new Error('智能体名称无效');
    const store = await readBindingStore(this.bindingFile);
    if (!(normalizedAgentName in store.bindings)) return;
    delete store.bindings[normalizedAgentName];
    await atomicWriteAsync(this.bindingFile, `${JSON.stringify(store, null, 2)}\n`);
  }

  async saveBinding(
    agentName: string,
    request: SaveGitHubDeliveryBindingRequest
  ): Promise<GitHubDeliveryBinding> {
    const normalizedAgentName = agentName.trim();
    if (!normalizedAgentName || normalizedAgentName.length > 120) throw new Error('智能体名称无效');
    const normalizedRepository = normalizeRepository(request.repository);
    const requestedTransport = request.transport;
    if (
      requestedTransport !== undefined &&
      requestedTransport !== 'https' &&
      requestedTransport !== 'ssh'
    ) {
      throw new Error('Git 传输方式无效');
    }
    const binding: GitHubDeliveryBinding = {
      agentName: normalizedAgentName,
      repository: normalizedRepository.repository,
      branch: assertBranch(request.branch ?? DEFAULT_BRANCH),
      transport: requestedTransport ?? normalizedRepository.transport,
      updatedAt: new Date().toISOString(),
    };
    const store = await readBindingStore(this.bindingFile);
    store.bindings[normalizedAgentName] = binding;
    await atomicWriteAsync(this.bindingFile, `${JSON.stringify(store, null, 2)}\n`);
    return binding;
  }

  async resolveArchivedVersion(
    teamName: string,
    taskId: string
  ): Promise<{ outputDir: string; versionDir: string; title: string; versionId: string }> {
    const { outputDir, manifest } = await findArchivedDeliverable(
      teamName,
      taskId,
      this.teamRootFor
    );
    const versionsDir = path.resolve(outputDir, 'versions');
    const versionDir = path.resolve(versionsDir, manifest.currentVersion);
    const version = manifest.versions.find((item) => item.id === manifest.currentVersion);
    const resultPath = version ? path.resolve(outputDir, version.resultFile) : '';
    if (
      !version ||
      !isPathInside(versionsDir, versionDir) ||
      !isPathInside(versionDir, resultPath) ||
      !(await stat(versionDir)).isDirectory() ||
      !(await stat(resultPath)).isFile()
    ) {
      throw new Error('已批准成果版本不可用');
    }
    const realOutputDir = await realpath(outputDir);
    const realVersionsDir = await realpath(versionsDir);
    const realVersionDir = await realpath(versionDir);
    const realResultPath = await realpath(resultPath);
    if (
      !isPathInside(realOutputDir, realVersionsDir) ||
      !isPathInside(realVersionsDir, realVersionDir) ||
      !isPathInside(realVersionDir, realResultPath)
    ) {
      throw new Error('已批准成果版本路径无效');
    }
    return {
      outputDir: realOutputDir,
      versionDir: realVersionDir,
      title: manifest.title,
      versionId: manifest.currentVersion,
    };
  }

  async publish({
    teamName,
    taskId,
    agentName,
  }: {
    teamName: string;
    taskId: string;
    agentName: string;
  }): Promise<GitHubDeliveryReceipt> {
    const store = await readBindingStore(this.bindingFile);
    const binding = store.bindings[agentName];
    if (!binding) throw new Error('该智能体尚未绑定 GitHub 仓库');
    const { versionDir, versionId } = await this.resolveArchivedVersion(teamName, taskId);
    const workspace = await mkdtemp(path.join(tmpdir(), 'agentpanel-github-delivery-'));
    const repositoryDir = path.join(workspace, 'repository');
    const destination = path.posix.join(
      'deliveries',
      safeSegment(teamName, 'team'),
      safeSegment(taskId, 'task'),
      safeSegment(versionId, 'version')
    );
    try {
      await executeFile('git', ['clone', '--depth=1', this.remoteUrlFor(binding), repositoryDir], {
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const remoteBranch = `refs/remotes/origin/${binding.branch}`;
      const remoteBranchExists = await executeFile(
        'git',
        ['fetch', '--depth=1', 'origin', `refs/heads/${binding.branch}:${remoteBranch}`],
        { cwd: repositoryDir, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }
      )
        .then(() => true)
        .catch(() => false);
      if (remoteBranchExists) {
        await executeFile('git', ['checkout', '-B', binding.branch, `origin/${binding.branch}`], {
          cwd: repositoryDir,
        });
      } else {
        await executeFile('git', ['checkout', '-B', binding.branch], { cwd: repositoryDir });
      }
      await cp(versionDir, path.join(repositoryDir, destination), {
        recursive: true,
        dereference: false,
        errorOnExist: false,
        force: true,
      });
      await writeFile(
        path.join(repositoryDir, destination, 'AGENTPANEL_DELIVERY.json'),
        `${JSON.stringify({ teamName, taskId, agentName, archivedAt: versionId }, null, 2)}\n`,
        'utf8'
      );
      await executeFile('git', ['add', '--', destination], { cwd: repositoryDir });
      const status = await executeFile('git', ['status', '--porcelain', '--', destination], {
        cwd: repositoryDir,
      });
      if (!status.stdout.trim()) {
        const commit = (
          await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryDir })
        ).stdout.trim();
        return {
          repository: binding.repository,
          branch: binding.branch,
          path: destination,
          commit,
          url: `https://github.com/${binding.repository}/tree/${encodeURIComponent(binding.branch)}/${destination}`,
          publishedAt: new Date().toISOString(),
        };
      }
      await executeFile(
        'git',
        [
          '-c',
          'user.name=AgentPanel Delivery',
          '-c',
          'user.email=delivery@agentpanel.local',
          'commit',
          '-m',
          `delivery: ${safeSegment(teamName, 'team')}/${safeSegment(taskId, 'task')}`,
          '--',
          destination,
        ],
        { cwd: repositoryDir }
      );
      const commit = (
        await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryDir })
      ).stdout.trim();
      await executeFile('git', ['push', 'origin', `HEAD:refs/heads/${binding.branch}`], {
        cwd: repositoryDir,
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        repository: binding.repository,
        branch: binding.branch,
        path: destination,
        commit,
        url: `https://github.com/${binding.repository}/tree/${encodeURIComponent(binding.branch)}/${destination}`,
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn({ err: error, repository: binding.repository }, 'GitHub delivery publish failed');
      throw new Error(
        `GitHub 交付失败：${error instanceof Error ? error.message : String(error)}。请确认 Git 已登录且仓库可写。`
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

/**
 * UpdateService — check GitHub Releases for Hermit updates and apply them.
 *
 * Works in two modes:
 *   1. Standalone (npm install): pulls latest git tag, updates via git pull + reinstall
 *   2. Global CLI (npm install -g): updates via npm update -g hermit
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the agentcli package root by walking up to the package.json whose
// name is @yancyyu/agentcli. Robust to layout (source src/main/ vs precompiled
// bundle dist/ vs future SEA exe) -- a hardcoded `../../..` only worked in
// source and broke in the bundle.
function findAgentCliRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    try {
      if (
        JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')).name ===
        '@yancyyu/agentcli'
      ) {
        return dir;
      }
    } catch {
      // missing or malformed package.json: keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: original src/main layout (three levels up from this file).
  return path.resolve(startDir, '..', '..', '..');
}

const REPO_ROOT = findAgentCliRoot(__dirname);

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
}

export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'installing' | 'completed' | 'error';
  message: string;
  progress?: number;
  error?: string;
}

const GITHUB_REPO = 'yancyuu/agentcli';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

export class UpdateService {
  private currentVersion: string;
  private isGitRepo: boolean;

  constructor() {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    this.currentVersion = pkg.version;

    this.isGitRepo = existsSync(path.join(REPO_ROOT, '.git'));
  }

  async checkForUpdates(): Promise<VersionInfo> {
    try {
      const res = await fetch(`${GITHUB_API}/latest`);
      if (!res.ok) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: null,
          updateAvailable: false,
        };
      }

      const data = await res.json();
      const latestVersion = data.tag_name?.replace(/^v/, '') ?? null;

      if (!latestVersion) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: null,
          updateAvailable: false,
        };
      }

      const updateAvailable = this.compareVersions(this.currentVersion, latestVersion) < 0;

      return {
        currentVersion: this.currentVersion,
        latestVersion,
        updateAvailable,
        releaseNotes: data.body ?? undefined,
        releaseUrl: data.html_url ?? undefined,
        publishedAt: data.published_at ?? undefined,
      };
    } catch {
      return {
        currentVersion: this.currentVersion,
        latestVersion: null,
        updateAvailable: false,
      };
    }
  }

  async applyUpdate(onProgress?: (progress: UpdateProgress) => void): Promise<boolean> {
    if (!this.isGitRepo) {
      return this.updateViaNpm(onProgress);
    }
    return this.updateViaGit(onProgress);
  }

  private async updateViaNpm(onProgress?: (progress: UpdateProgress) => void): Promise<boolean> {
    try {
      onProgress?.({ phase: 'checking', message: 'Checking for updates to latest version...' });

      const versionInfo = await this.checkForUpdates();
      if (!versionInfo.updateAvailable || !versionInfo.latestVersion) {
        onProgress?.({ phase: 'completed', message: 'Already on latest version' });
        return false;
      }

      onProgress?.({
        phase: 'downloading',
        message: `New version available: ${versionInfo.latestVersion} (current: ${this.currentVersion})`,
      });
      onProgress?.({ phase: 'installing', message: 'Installing update...' });
      onProgress?.({ phase: 'installing', message: 'Using global installation update method...' });
      execSync('npm update -g hermit', { cwd: REPO_ROOT, stdio: 'pipe' });

      onProgress?.({
        phase: 'completed',
        message: `Successfully updated from ${this.currentVersion} to version ${versionInfo.latestVersion}`,
      });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ phase: 'error', message: 'Update failed', error: message });
      throw err;
    }
  }

  private async updateViaGit(onProgress?: (progress: UpdateProgress) => void): Promise<boolean> {
    try {
      onProgress?.({ phase: 'checking', message: 'Checking for updates to latest version...' });

      const versionInfo = await this.checkForUpdates();
      if (!versionInfo.updateAvailable || !versionInfo.latestVersion) {
        onProgress?.({ phase: 'completed', message: 'Already on latest version' });
        return false;
      }

      onProgress?.({
        phase: 'downloading',
        message: `New version available: ${versionInfo.latestVersion} (current: ${this.currentVersion})`,
      });
      onProgress?.({ phase: 'installing', message: 'Installing update...' });
      onProgress?.({ phase: 'installing', message: 'Using git installation update method...' });
      execSync('git fetch --tags', { cwd: REPO_ROOT, stdio: 'pipe' });
      execFileSync('git', ['checkout', `v${versionInfo.latestVersion}`], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      execSync('npm install', { cwd: REPO_ROOT, stdio: 'pipe' });
      execSync('npm run build:web', { cwd: REPO_ROOT, stdio: 'pipe' });

      onProgress?.({
        phase: 'completed',
        message: `Successfully updated from ${this.currentVersion} to version ${versionInfo.latestVersion}`,
      });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ phase: 'error', message: 'Update failed', error: message });
      throw err;
    }
  }

  private compareVersions(a: string, b: string): number {
    const parse = (v: string) => v.split('.').map(Number);
    const [a1, a2, a3] = parse(a);
    const [b1, b2, b3] = parse(b);

    if (a1 !== b1) return (a1 ?? 0) - (b1 ?? 0);
    if (a2 !== b2) return (a2 ?? 0) - (b2 ?? 0);
    return (a3 ?? 0) - (b3 ?? 0);
  }
}

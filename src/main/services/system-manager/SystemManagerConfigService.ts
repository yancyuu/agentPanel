import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  SystemManagerConfig,
  SystemManagerConfigPatch,
  SystemManagerStatus,
} from '@shared/types/systemManager';

const CONFIG_FILE = 'system-manager.json';

function hermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

/**
 * Canonical runtime path for the 诊断. The admin loop is a normal Claude
 * Code workspace rooted at ~/.hermit: commands are read from .claude/commands
 * and CLAUDE.md from the same root. This is fixed — the workspace is not
 * user-selectable, so the 诊断 always reports ~/.hermit as its scope.
 */
export function adminWorkDir(): string {
  return hermitHome();
}

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    try {
      await access(path.join(dir, command));
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export class SystemManagerConfigService {
  private readonly configPath = path.join(hermitHome(), CONFIG_FILE);

  async getConfig(): Promise<SystemManagerConfig> {
    const parsed = await this.readPersisted();
    const config: SystemManagerConfig = {
      schemaVersion: 1,
      selectedWorkDir: adminWorkDir(),
      ...(parsed.adminInitialized ? { adminInitialized: true } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };

    // Self-heal: the 诊断 workspace is fixed at ~/.hermit and intentionally
    // not configurable, so any other persisted selectedWorkDir is stale drift.
    // Rewrite it once so the file stops advertising a misleading path.
    if (parsed.selectedWorkDir !== undefined && parsed.selectedWorkDir !== adminWorkDir()) {
      await this.persist(config);
    }

    return config;
  }

  async updateConfig(patch: SystemManagerConfigPatch): Promise<SystemManagerConfig> {
    const current = await this.getConfig();
    const next: SystemManagerConfig = {
      ...current,
      updatedAt: new Date().toISOString(),
    };

    // Only adminInitialized is mutable. selectedWorkDir is the canonical
    // ~/.hermit workspace and is intentionally not configurable.
    if (typeof patch.adminInitialized === 'boolean') {
      next.adminInitialized = patch.adminInitialized;
    }

    await this.persist(next);
    return next;
  }

  private async persist(config: SystemManagerConfig): Promise<void> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async getStatus(): Promise<SystemManagerStatus> {
    const hasClaude = await commandExists('claude');
    return {
      displayName: '诊断',
      adminWorkDir: adminWorkDir(),
      defaultWorkDir: adminWorkDir(),
      selectedWorkDir: adminWorkDir(),
      claudeCommand: 'claude',
      localStatus: hasClaude ? 'ready' : 'missing-claude',
      ...(hasClaude ? {} : { error: '未在 PATH 中找到 claude 命令' }),
    };
  }

  private async readPersisted(): Promise<Partial<SystemManagerConfig>> {
    try {
      return JSON.parse(await readFile(this.configPath, 'utf-8')) as Partial<SystemManagerConfig>;
    } catch {
      return {};
    }
  }
}

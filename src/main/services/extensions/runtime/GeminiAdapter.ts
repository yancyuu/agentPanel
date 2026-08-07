/**
 * Gemini harness adapter — uses `gemini` CLI for MCP and skills.
 */

import path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';

import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';

import type {
  HarnessInstallAdapter,
  InstallOpts,
  ResolvedSkillRoot,
} from './HarnessInstallAdapter';
import type {
  InstalledMcpEntry,
  InstalledPluginEntry,
  McpHeaderDef,
  McpInstallSpec,
  OperationResult,
} from '@shared/types/extensions';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

function resolveBinaryFromPath(binaryName: string): Promise<string | null> {
  return new Promise((resolve) => {
    import('node:child_process')
      .then(({ execFile }) => {
        execFile(
          process.platform === 'win32' ? 'where' : 'which',
          [binaryName],
          { timeout: 5_000 },
          (err, stdout) => {
            resolve(err || !stdout?.trim() ? null : stdout.trim());
          }
        );
      })
      .catch(() => resolve(null));
  });
}

export class GeminiAdapter implements HarnessInstallAdapter {
  readonly harnessType: HermitBridgeAgentType = 'gemini';
  readonly supportsPlugins = false;
  readonly supportsMcp = true;
  readonly supportsSkills = true;

  private readonly delegate = new ClaudeCodeAdapter();

  async resolveBinary(): Promise<string | null> {
    return resolveBinaryFromPath('gemini');
  }

  async installPlugin(): Promise<OperationResult> {
    return { state: 'error', error: 'Gemini does not support Claude plugins' };
  }
  async uninstallPlugin(): Promise<OperationResult> {
    return { state: 'error', error: 'Gemini does not support Claude plugins' };
  }

  async installMcp(
    name: string,
    spec: McpInstallSpec,
    envValues: Record<string, string>,
    headers: McpHeaderDef[],
    opts: InstallOpts
  ): Promise<OperationResult> {
    return this.delegate.installMcp(name, spec, envValues, headers, opts);
  }

  async uninstallMcp(name: string, opts: InstallOpts): Promise<OperationResult> {
    return this.delegate.uninstallMcp(name, opts);
  }

  async listInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    return this.delegate.listInstalledMcp(projectPath);
  }

  async listInstalledPlugins(): Promise<InstalledPluginEntry[]> {
    return [];
  }

  getSkillRoots(projectPath?: string): ResolvedSkillRoot[] {
    const home = getHomeDir();
    const roots: ResolvedSkillRoot[] = [
      { kind: 'gemini', scope: 'user', path: path.join(home, '.gemini', 'skills') },
    ];
    if (projectPath) {
      roots.push({
        kind: 'gemini',
        scope: 'project',
        path: path.join(projectPath, '.gemini', 'skills'),
      });
    }
    return roots;
  }
}

/**
 * Cursor harness adapter — writes config files directly (no CLI for MCP).
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

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

const logger = createLogger('Extensions:CursorAdapter');

export class CursorAdapter implements HarnessInstallAdapter {
  readonly harnessType = 'cursor' as const;
  readonly supportsPlugins = false;
  readonly supportsMcp = true;
  readonly supportsSkills = true;

  async resolveBinary(): Promise<string | null> {
    // Cursor doesn't have a CLI for MCP management
    return null;
  }

  async installMcp(
    name: string,
    spec: McpInstallSpec,
    envValues: Record<string, string>,
    _headers: McpHeaderDef[],
    opts: InstallOpts
  ): Promise<OperationResult> {
    if (!opts.projectPath) {
      return { state: 'error', error: 'Cursor MCP requires a project path (.cursor/mcp.json)' };
    }

    const mcpPath = path.join(opts.projectPath, '.cursor', 'mcp.json');
    let config: Record<string, unknown> = {};

    try {
      const raw = await fs.readFile(mcpPath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // file doesn't exist yet
    }

    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};

    if (spec.type === 'stdio') {
      mcpServers[name] = {
        command: 'npx',
        args: ['-y', spec.npmVersion ? `${spec.npmPackage}@${spec.npmVersion}` : spec.npmPackage],
        env: envValues,
      };
    } else if (spec.type === 'http') {
      mcpServers[name] = {
        url: spec.url,
        ...(spec.transportType === 'sse' && { type: 'sse' }),
      };
    }

    config.mcpServers = mcpServers;

    try {
      await fs.mkdir(path.dirname(mcpPath), { recursive: true });
      await fs.writeFile(mcpPath, JSON.stringify(config, null, 2));
      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: 'error', error: `Failed to write .cursor/mcp.json: ${message}` };
    }
  }

  async uninstallMcp(name: string, opts: InstallOpts): Promise<OperationResult> {
    if (!opts.projectPath) {
      return { state: 'error', error: 'Cursor MCP requires a project path' };
    }

    const mcpPath = path.join(opts.projectPath, '.cursor', 'mcp.json');

    try {
      const raw = await fs.readFile(mcpPath, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
      if (mcpServers && name in mcpServers) {
        delete mcpServers[name];
        await fs.writeFile(mcpPath, JSON.stringify(config, null, 2));
      }
      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: 'error', error: `Failed to update .cursor/mcp.json: ${message}` };
    }
  }

  async installPlugin(): Promise<OperationResult> {
    return { state: 'error', error: 'Cursor does not support Claude plugins' };
  }

  async uninstallPlugin(): Promise<OperationResult> {
    return { state: 'error', error: 'Cursor does not support Claude plugins' };
  }

  async listInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    if (!projectPath) return [];
    const mcpPath = path.join(projectPath, '.cursor', 'mcp.json');

    try {
      const raw = await fs.readFile(mcpPath, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = config.mcpServers as
        | Record<string, { command?: string; url?: string }>
        | undefined;
      if (!mcpServers) return [];

      return Object.entries(mcpServers).map(([name, server]) => ({
        name,
        scope: 'project' as const,
        transport: server.command ? 'stdio' : server.url ? 'http' : undefined,
      }));
    } catch {
      return [];
    }
  }

  async listInstalledPlugins(): Promise<InstalledPluginEntry[]> {
    return [];
  }

  getSkillRoots(projectPath?: string): ResolvedSkillRoot[] {
    const home = getHomeDir();
    const roots: ResolvedSkillRoot[] = [
      { kind: 'cursor', scope: 'user', path: path.join(home, '.cursor', 'skills') },
    ];
    if (projectPath) {
      roots.push({
        kind: 'cursor',
        scope: 'project',
        path: path.join(projectPath, '.cursor', 'skills'),
      });
    }
    return roots;
  }
}

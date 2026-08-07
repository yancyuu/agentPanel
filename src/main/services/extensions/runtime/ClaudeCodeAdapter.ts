/**
 * Claude Code harness adapter — uses `claude` CLI for plugin/MCP/skills.
 */

import path from 'node:path';

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli } from '@main/utils/childProcess';
import { getHomeDir } from '@main/utils/pathDecoder';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';
import { createLogger } from '@shared/utils/logger';

import { McpConfigStateReader } from './McpConfigStateReader';

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

const logger = createLogger('Extensions:CCAdapter');

const QUALIFIED_NAME_RE = /^[\w.-]+@[\w.-]+$/;
const VALID_SCOPES = new Set(['local', 'user', 'project', 'global']);
const SERVER_NAME_RE = /^[\w.-]{1,100}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,100}$/i;
const HEADER_KEY_RE = /^[A-Za-z][\w-]{0,100}$/;
const PLUGIN_TIMEOUT_MS = 120_000;
const MCP_TIMEOUT_MS = 30_000;

function scopeRequiresProjectPath(scope?: string): boolean {
  return scope === 'project' || scope === 'local';
}

function maskSecrets(
  message: string,
  envValues: Record<string, string>,
  headerValues: string[]
): string {
  let result = message;
  const secrets = [
    ...Object.values(envValues).filter((v) => v.length > 3),
    ...headerValues.filter((v) => v.length > 3),
  ];
  for (const secret of secrets) {
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}

export class ClaudeCodeAdapter implements HarnessInstallAdapter {
  readonly harnessType: HermitBridgeAgentType = 'claudecode';
  readonly supportsPlugins = true;
  readonly supportsMcp = true;
  readonly supportsSkills = true;

  private readonly configReader = new McpConfigStateReader();

  async resolveBinary(): Promise<string | null> {
    return ClaudeBinaryResolver.resolve();
  }

  async installPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult> {
    if (!QUALIFIED_NAME_RE.test(qualifiedName)) {
      return { state: 'error', error: `Invalid plugin identifier: ${qualifiedName}` };
    }
    if (opts.scope && !VALID_SCOPES.has(opts.scope)) {
      return { state: 'error', error: `Invalid scope: "${opts.scope}"` };
    }
    if (scopeRequiresProjectPath(opts.scope) && !opts.projectPath) {
      return { state: 'error', error: 'projectPath is required for project-scoped installs' };
    }

    const args = ['plugin', 'install'];
    if (opts.scope && opts.scope !== 'user') args.push('-s', opts.scope);
    args.push(qualifiedName);

    return this.runCli(args, { timeout: PLUGIN_TIMEOUT_MS, cwd: opts.projectPath });
  }

  async uninstallPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult> {
    if (!QUALIFIED_NAME_RE.test(qualifiedName)) {
      return { state: 'error', error: `Invalid plugin identifier: ${qualifiedName}` };
    }

    const args = ['plugin', 'uninstall'];
    if (opts.scope && opts.scope !== 'user') args.push('-s', opts.scope);
    args.push(qualifiedName);

    return this.runCli(args, { timeout: 30_000, cwd: opts.projectPath });
  }

  async installMcp(
    name: string,
    spec: McpInstallSpec,
    envValues: Record<string, string>,
    headers: McpHeaderDef[],
    opts: InstallOpts
  ): Promise<OperationResult> {
    if (!SERVER_NAME_RE.test(name)) {
      return { state: 'error', error: `Invalid server name: "${name}"` };
    }

    const args: string[] = ['mcp', 'add'];
    if (opts.scope && opts.scope !== 'local') args.push('-s', opts.scope);

    if (spec.type === 'stdio') {
      for (const [key, value] of Object.entries(envValues)) {
        if (key && value && ENV_KEY_RE.test(key)) args.push('-e', `${key}=${value}`);
      }
      args.push(name, '--', 'npx', '-y');
      args.push(spec.npmVersion ? `${spec.npmPackage}@${spec.npmVersion}` : spec.npmPackage);
    } else if (spec.type === 'http') {
      args.push('-t', spec.transportType === 'sse' ? 'sse' : 'http');
      // Positional args must come before variadic flags (-H, -e)
      // to prevent the CLI parser from consuming them as flag values
      args.push(name, spec.url);
      for (const header of headers) {
        if (header.key && header.value && HEADER_KEY_RE.test(header.key))
          args.push('-H', `${header.key}: ${header.value}`);
      }
      for (const [key, value] of Object.entries(envValues)) {
        if (key && value && ENV_KEY_RE.test(key)) args.push('-e', `${key}=${value}`);
      }
    } else {
      return { state: 'error', error: `Unsupported install spec type` };
    }

    try {
      return await this.runCli(args, { timeout: MCP_TIMEOUT_MS, cwd: opts.projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safe = maskSecrets(
        message,
        envValues,
        headers.map((h) => h.value)
      );
      return { state: 'error', error: safe };
    }
  }

  async uninstallMcp(name: string, opts: InstallOpts): Promise<OperationResult> {
    const args = ['mcp', 'remove'];
    if (opts.scope && opts.scope !== 'local') args.push('-s', opts.scope);
    args.push(name);
    return this.runCli(args, { timeout: MCP_TIMEOUT_MS, cwd: opts.projectPath });
  }

  async listInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    return this.configReader.readInstalled(projectPath);
  }

  async listInstalledPlugins(_projectPath?: string): Promise<InstalledPluginEntry[]> {
    // Plugin listing would read from ~/.claude/plugins/installed_plugins.json
    // Stub for now — will be implemented in Phase 3
    return [];
  }

  getSkillRoots(projectPath?: string): ResolvedSkillRoot[] {
    const home = getHomeDir();
    const roots: ResolvedSkillRoot[] = [
      { kind: 'claude', scope: 'user', path: path.join(home, '.claude', 'commands') },
    ];
    if (projectPath) {
      roots.push({
        kind: 'claude',
        scope: 'project',
        path: path.join(projectPath, '.claude', 'commands'),
      });
    }
    return roots;
  }

  private async runCli(
    args: string[],
    opts: { timeout: number; cwd?: string }
  ): Promise<OperationResult> {
    const binary = await this.resolveBinary();
    if (!binary) {
      return { state: 'error', error: CLI_NOT_FOUND_MESSAGE };
    }

    try {
      await execCli(binary, args, { timeout: opts.timeout, cwd: opts.cwd });
      return { state: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`CLI command failed: ${message}`);
      return { state: 'error', error: message };
    }
  }
}

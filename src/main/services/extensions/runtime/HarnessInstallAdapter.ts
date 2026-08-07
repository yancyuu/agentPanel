/**
 * Harness install adapter interface.
 *
 * Each supported harness implements this interface to provide
 * harness-specific installation commands and configuration paths.
 */

import type { McpHeaderDef, McpInstallSpec, OperationResult } from '@shared/types/extensions';
import type { InstalledMcpEntry } from '@shared/types/extensions';
import type { InstalledPluginEntry } from '@shared/types/extensions';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

export interface InstallOpts {
  scope: 'user' | 'project' | 'local' | 'global';
  projectPath?: string;
}

export interface ResolvedSkillRoot {
  kind: string;
  scope: 'user' | 'project';
  path: string;
}

export interface HarnessInstallAdapter {
  readonly harnessType: HermitBridgeAgentType;
  readonly supportsPlugins: boolean;
  readonly supportsMcp: boolean;
  readonly supportsSkills: boolean;

  resolveBinary(): Promise<string | null>;

  installPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult>;
  uninstallPlugin(qualifiedName: string, opts: InstallOpts): Promise<OperationResult>;

  installMcp(
    name: string,
    spec: McpInstallSpec,
    envValues: Record<string, string>,
    headers: McpHeaderDef[],
    opts: InstallOpts
  ): Promise<OperationResult>;
  uninstallMcp(name: string, opts: InstallOpts): Promise<OperationResult>;

  listInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]>;
  listInstalledPlugins(projectPath?: string): Promise<InstalledPluginEntry[]>;

  getSkillRoots(projectPath?: string): ResolvedSkillRoot[];
}

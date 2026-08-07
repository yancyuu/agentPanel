/**
 * Provider-aware CLI environment builder.
 *
 * Builds an enriched environment for CLI processes that accounts for
 * provider-specific configuration (API keys, base URLs, etc.), and resolves the
 * provider launch fields (model, effort, worktree, ...) into concrete CLI args
 * via {@link resolveProviderLaunchArgs}.
 *
 * NOTE: The full source in claude_agent_teams_ui depends on several services
 * not yet available in this project (ProviderConnectionService, OpenCodeRuntime,
 * codex-runtime-installer). This module provides the core interface, environment
 * building, and provider arg resolution, falling back gracefully when those
 * services are absent.
 */

import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { resolveProviderLaunchArgs } from '@shared/utils/providerLaunchArgs';

import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface ProviderAwareCliEnvOptions {
  binaryPath?: string | null;
  providerId?: string;
  providerBackendId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  clearContext?: boolean;
  shellEnv?: NodeJS.ProcessEnv | null;
  env?: NodeJS.ProcessEnv;
  connectionMode?: 'strict' | 'augment';
  allowStoredApiKeyDecryption?: boolean;
  allowedStoredApiKeyEnvVarNames?: readonly string[];
  projectPath?: string;
}

export interface ProviderAwareCliEnvResult {
  env: NodeJS.ProcessEnv;
  connectionIssues: Record<string, string>;
  providerArgs: string[];
}

export async function buildProviderAwareCliEnv(
  options: ProviderAwareCliEnvOptions = {}
): Promise<ProviderAwareCliEnvResult> {
  const env = buildEnrichedEnv(options.binaryPath);

  // Remove ELECTRON_RUN_AS_NODE to prevent child processes from thinking
  // they are running in Node.js mode instead of Electron mode.
  delete env.ELECTRON_RUN_AS_NODE;

  // Inject project-level env vars (from CredentialService) when a projectPath is provided
  if (options.projectPath) {
    try {
      const { CredentialService } =
        await import('@main/services/extensions/credentials/CredentialService');
      const credentials = new CredentialService();
      const projectEnv = await credentials.resolveAgentEnv(options.projectPath);
      Object.assign(env, projectEnv);
    } catch {
      // Non-critical — CLI will use system env as fallback
    }
  }

  // Resolve provider launch fields into concrete CLI args. When no provider/model
  // information is supplied, the resolver returns an empty arg list (backward
  // compatible with callers that only need the enriched env).
  const resolution = resolveProviderLaunchArgs({
    providerId: options.providerId as TeamProviderId | undefined,
    providerBackendId: options.providerBackendId ?? null,
    model: options.model,
    effort: options.effort,
    skipPermissions: options.skipPermissions,
    worktree: options.worktree,
    extraCliArgs: options.extraCliArgs,
    limitContext: options.limitContext,
    clearContext: options.clearContext,
  });

  return {
    env,
    connectionIssues: resolution.connectionIssues,
    providerArgs: resolution.providerArgs,
  };
}

import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { TeamProviderId } from '@shared/types';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
} from '@shared/types/cliInstaller';

export function filterMainScreenCliProviders<
  T extends {
    providerId: CliProviderId;
  },
>(providers: readonly T[]): T[] {
  return providers.filter((provider) => ['anthropic', 'codex'].includes(provider.providerId));
}

function createClaudeCodeProviderFromCliStatus(status: CliInstallationStatus): CliProviderStatus {
  const authenticated = status.authLoggedIn;
  return {
    providerId: 'anthropic',
    displayName: 'Claude Code',
    supported: status.installed,
    authenticated,
    authMethod: authenticated ? (status.authMethod ?? 'subscription') : null,
    verificationState: status.installed ? (authenticated ? 'verified' : 'unknown') : 'offline',
    modelVerificationState: 'idle',
    statusMessage: status.authStatusChecking
      ? 'Checking...'
      : authenticated
        ? 'Connected'
        : status.installed
          ? 'Not connected'
          : 'Claude Code CLI unavailable',
    detailMessage: status.launchError ?? null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: status.installed,
      oneShot: status.installed,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: {
      kind: 'claude-code',
      label: status.installedVersion ? `Claude Code v${status.installedVersion}` : 'Claude Code',
    },
  };
}

function createCodexProviderFallback(status: CliInstallationStatus): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: status.installed,
    authenticated: false,
    authMethod: null,
    verificationState: status.installed ? 'unknown' : 'offline',
    modelVerificationState: 'idle',
    statusMessage: status.installed ? '需要连接 Codex' : 'Agent CLI 不可用',
    detailMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: 'codex-native',
    resolvedBackendId: 'codex-native',
    backend: {
      kind: 'codex-native',
      label: 'Codex native',
    },
  };
}

export function getMainScreenCliProviders(
  status: CliInstallationStatus | null | undefined
): CliProviderStatus[] {
  if (!status) {
    return [];
  }

  const providers = filterMainScreenCliProviders(status.providers);
  const hasClaudeCode = providers.some((provider) => provider.providerId === 'anthropic');
  const withClaudeCode: CliProviderStatus[] = hasClaudeCode
    ? providers
    : [createClaudeCodeProviderFromCliStatus(status), ...providers];
  const hasCodex = withClaudeCode.some((provider) => provider.providerId === 'codex');
  const withRequiredProviders = hasCodex
    ? withClaudeCode
    : [...withClaudeCode, createCodexProviderFallback(status)];

  return withRequiredProviders.sort((left, right) => {
    const order: Record<CliProviderId, number> = {
      anthropic: 0,
      codex: 1,
      gemini: 2,
      opencode: 3,
    };
    return order[left.providerId] - order[right.providerId];
  });
}

export function normalizeCreateLaunchProviderForUi(
  providerId: TeamProviderId | undefined,
  _multimodelEnabled: boolean
): TeamProviderId {
  return providerId === 'anthropic' || providerId === 'codex' ? providerId : 'anthropic';
}

export function isCreateLaunchProviderDisabled(
  providerId: TeamProviderId,
  _multimodelEnabled: boolean
): boolean {
  return !['anthropic', 'codex'].includes(providerId);
}

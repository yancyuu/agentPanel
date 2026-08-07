import { filterMainScreenCliProviders } from './claudeCodeOnlyProviders';

import type {
  CliExtensionCapability,
  CliInstallationStatus,
  CliProviderStatus,
} from '@shared/types';

export function getVisibleMultimodelProviders(
  providers: readonly CliProviderStatus[]
): CliProviderStatus[] {
  return filterMainScreenCliProviders(providers);
}

/**
 * Further filters the visible providers to those the Extension Store can actually manage.
 * Providers where ALL extension capabilities are 'provider-scoped' own their own config
 * and cannot be managed via the Extension Store UI, so they are excluded from capability cards.
 */
export function filterExtensionStoreProviders(providers: CliProviderStatus[]): CliProviderStatus[] {
  return providers.filter((p) => {
    const ext = p.capabilities?.extensions;
    if (!ext) return false;
    return (
      ext.plugins.ownership !== 'provider-scoped' ||
      ext.mcp.ownership !== 'provider-scoped' ||
      ext.skills.ownership !== 'provider-scoped'
    );
  });
}

export function isMultimodelRuntimeStatus(
  cliStatus: Pick<CliInstallationStatus, 'flavor' | 'providers'> | null | undefined
): boolean {
  return cliStatus?.flavor === 'agent_teams_orchestrator';
}

export function formatCliExtensionCapabilityStatus(
  status: CliExtensionCapability['status']
): string {
  switch (status) {
    case 'supported':
      return '支持';
    case 'read-only':
      return '只读';
    default:
      return '不支持';
  }
}

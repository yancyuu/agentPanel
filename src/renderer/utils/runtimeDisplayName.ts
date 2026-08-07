import type { CliFlavor, CliInstallationStatus } from '@shared/types';

const AGENT_CLI_RUNTIME_LABEL = 'Agent CLI';

export function getRuntimeDisplayName(
  cliStatus: Pick<CliInstallationStatus, 'flavor' | 'displayName'> | null | undefined,
  multimodelEnabledFallback = false
): string {
  if (cliStatus?.flavor === 'agent_teams_orchestrator') {
    if (!cliStatus.displayName || cliStatus.displayName === 'agent_teams_orchestrator') {
      return AGENT_CLI_RUNTIME_LABEL;
    }

    return cliStatus.displayName;
  }

  if (cliStatus?.displayName) {
    return cliStatus.displayName;
  }

  return multimodelEnabledFallback ? AGENT_CLI_RUNTIME_LABEL : 'Agent CLI';
}

export function getRuntimeCommandLabel(flavor: CliFlavor): string {
  return flavor === 'agent_teams_orchestrator' ? AGENT_CLI_RUNTIME_LABEL : 'Agent CLI';
}

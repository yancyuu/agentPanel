import { getProviderScopedTeamModelLabel } from '@renderer/utils/teamModelCatalog';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';

import type { TeamProviderId, TeamProvisioningPrepareResult } from '@shared/types';

export type ProviderPrepareCheckStatus = 'ready' | 'notes' | 'failed';

type PrepareProvisioningFn = (
  cwd?: string,
  providerId?: TeamProviderId,
  providerIds?: TeamProviderId[],
  selectedModels?: string[],
  limitContext?: boolean
) => Promise<TeamProvisioningPrepareResult>;

interface ProviderPrepareDiagnosticsProgress {
  status: ProviderPrepareCheckStatus | 'checking';
  details: string[];
  completedCount: number;
  totalCount: number;
}

export interface ProviderPrepareDiagnosticsModelResult {
  status: 'ready' | 'notes' | 'failed';
  line: string;
  warningLine?: string | null;
}

export interface ProviderPrepareDiagnosticsCachedSnapshot {
  status: ProviderPrepareCheckStatus | 'checking';
  details: string[];
  completedCount: number;
  totalCount: number;
}

export interface ProviderPrepareDiagnosticsResult {
  status: ProviderPrepareCheckStatus;
  details: string[];
  warnings: string[];
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>;
}

function getModelLabel(providerId: TeamProviderId, modelId: string): string {
  if (isDefaultProviderModelSelection(modelId)) {
    return '默认';
  }
  return getProviderScopedTeamModelLabel(providerId, modelId) ?? modelId;
}

export function buildProviderPrepareModelCheckingLine(
  providerId: TeamProviderId,
  modelId: string
): string {
  return `${getModelLabel(providerId, modelId)} - checking...`;
}

function buildModelSuccessLine(providerId: TeamProviderId, modelId: string): string {
  return `${getModelLabel(providerId, modelId)} - verified`;
}

function buildModelFailureLine(
  providerId: TeamProviderId,
  modelId: string,
  reason: string
): string {
  const label = getModelLabel(providerId, modelId);
  return `${label} - sidecar check failed${reason.trim() ? ` (${reason.trim()})` : ''}`;
}

function createRuntimeDetailLines(result: TeamProvisioningPrepareResult): string[] {
  const details = Array.isArray(result.details) ? result.details.filter(Boolean) : [];
  if (details.length > 0) {
    return details;
  }
  return result.message?.trim() ? [result.message.trim()] : [];
}

function getModelReasonFromResult(
  modelId: string,
  result: TeamProvisioningPrepareResult
): string | null {
  const candidates = [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);
  const lowerModelId = modelId.toLowerCase();
  return candidates.find((entry) => entry.toLowerCase().includes(lowerModelId)) ?? null;
}

export function buildReusableProviderPrepareModelResults(
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>
): Record<string, ProviderPrepareDiagnosticsModelResult> {
  return { ...modelResultsById };
}

export function getProviderPrepareCachedSnapshot({
  providerId,
  selectedModelIds,
  cachedModelResultsById,
}: {
  providerId: TeamProviderId;
  selectedModelIds: string[];
  cachedModelResultsById?: Record<string, ProviderPrepareDiagnosticsModelResult>;
}): ProviderPrepareDiagnosticsCachedSnapshot {
  const orderedModelIds = Array.from(
    new Set(selectedModelIds.map((modelId) => modelId.trim()).filter(Boolean))
  );
  const details = orderedModelIds.map((modelId) => {
    const cached = cachedModelResultsById?.[modelId];
    return cached?.line ?? buildProviderPrepareModelCheckingLine(providerId, modelId);
  });
  const completedCount = orderedModelIds.filter((modelId) =>
    Boolean(cachedModelResultsById?.[modelId])
  ).length;
  const status: ProviderPrepareCheckStatus | 'checking' =
    completedCount < orderedModelIds.length
      ? 'checking'
      : orderedModelIds.some((modelId) => cachedModelResultsById?.[modelId]?.status === 'failed')
        ? 'failed'
        : orderedModelIds.some((modelId) => cachedModelResultsById?.[modelId]?.status === 'notes')
          ? 'notes'
          : 'ready';
  return {
    status,
    details,
    completedCount,
    totalCount: orderedModelIds.length,
  };
}

export async function runProviderPrepareDiagnostics({
  cwd,
  providerId,
  selectedModelIds,
  prepareProvisioning,
  limitContext,
  onModelProgress,
}: {
  cwd: string;
  providerId: TeamProviderId;
  selectedModelIds: string[];
  prepareProvisioning: PrepareProvisioningFn;
  limitContext?: boolean;
  onModelProgress?: (progress: ProviderPrepareDiagnosticsProgress) => void;
  cachedModelResultsById?: Record<string, ProviderPrepareDiagnosticsModelResult>;
}): Promise<ProviderPrepareDiagnosticsResult> {
  const orderedModelIds = Array.from(
    new Set(selectedModelIds.map((modelId) => modelId.trim()).filter(Boolean))
  );

  onModelProgress?.({
    status: orderedModelIds.length > 0 ? 'checking' : 'ready',
    details: orderedModelIds.map((modelId) =>
      buildProviderPrepareModelCheckingLine(providerId, modelId)
    ),
    completedCount: 0,
    totalCount: orderedModelIds.length,
  });

  const runtimeResult = await prepareProvisioning(
    cwd,
    providerId,
    [providerId],
    orderedModelIds.length > 0 ? orderedModelIds : undefined,
    limitContext
  );
  const runtimeDetails = createRuntimeDetailLines(runtimeResult);
  const runtimeWarnings = Array.from(new Set(runtimeResult.warnings ?? []));
  const modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult> = {};

  if (!runtimeResult.ready) {
    for (const modelId of orderedModelIds) {
      const reason =
        getModelReasonFromResult(modelId, runtimeResult) ?? runtimeResult.message ?? '';
      const line = buildModelFailureLine(providerId, modelId, reason);
      modelResultsById[modelId] = {
        status: 'failed',
        line,
        warningLine: line,
      };
    }
    const details = [
      ...runtimeDetails,
      ...orderedModelIds.map((modelId) => modelResultsById[modelId]?.line ?? ''),
    ];
    onModelProgress?.({
      status: 'failed',
      details,
      completedCount: orderedModelIds.length,
      totalCount: orderedModelIds.length,
    });
    return {
      status: 'failed',
      details,
      warnings: runtimeWarnings,
      modelResultsById,
    };
  }

  for (const modelId of orderedModelIds) {
    modelResultsById[modelId] = {
      status: 'ready',
      line: `${buildModelSuccessLine(providerId, modelId)} (sidecar)`,
    };
  }
  const details = [
    ...runtimeDetails,
    ...orderedModelIds.map((modelId) => modelResultsById[modelId].line),
  ];
  const status: ProviderPrepareCheckStatus = runtimeWarnings.length > 0 ? 'notes' : 'ready';
  onModelProgress?.({
    status,
    details,
    completedCount: orderedModelIds.length,
    totalCount: orderedModelIds.length,
  });
  return {
    status,
    details,
    warnings: runtimeWarnings,
    modelResultsById,
  };
}

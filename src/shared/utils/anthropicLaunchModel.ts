import { getAnthropicDefaultTeamModel } from './anthropicModelDefaults';
import { isDefaultProviderModelSelection } from './providerModelSelection';

function stripOneMillionSuffix(model: string): string {
  return model.replace(/(?:\[1m\])+$/i, '');
}

function supportsOneMillionContext(model: string): boolean {
  const normalized = stripOneMillionSuffix(model.trim().toLowerCase());
  return (
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized.startsWith('claude-opus-') ||
    normalized.startsWith('claude-sonnet-')
  );
}

function getOneMillionLaunchModel(model: string, limitContext: boolean | undefined): string {
  const baseModel = stripOneMillionSuffix(model.trim());
  if (!baseModel || limitContext || !supportsOneMillionContext(baseModel)) {
    return baseModel;
  }
  return `${baseModel}[1m]`;
}

function normalizeAvailableLaunchModels(
  availableLaunchModels: Iterable<string> | undefined
): Set<string> {
  const normalized = new Set<string>();
  for (const model of availableLaunchModels ?? []) {
    const trimmed = model.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function chooseAvailableModel(
  availableModels: Set<string>,
  candidates: readonly string[]
): string | null {
  if (availableModels.size === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (availableModels.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveAnthropicLaunchModel(params: {
  selectedModel?: string | null;
  limitContext?: boolean;
  availableLaunchModels?: Iterable<string>;
  defaultLaunchModel?: string | null;
}): string | null {
  const selectedModel = params.selectedModel?.trim() ?? '';
  const availableModels = normalizeAvailableLaunchModels(params.availableLaunchModels);

  if (!selectedModel || isDefaultProviderModelSelection(selectedModel)) {
    const staticDefault = getAnthropicDefaultTeamModel(params.limitContext);
    const runtimeDefault = params.defaultLaunchModel?.trim() || null;
    const preferredDefault = getOneMillionLaunchModel(staticDefault, params.limitContext);
    const runtimeDefaultBase = runtimeDefault ? stripOneMillionSuffix(runtimeDefault) : null;
    if (availableModels.size === 0) {
      return preferredDefault;
    }

    return (
      chooseAvailableModel(availableModels, [
        preferredDefault,
        runtimeDefault ? getOneMillionLaunchModel(runtimeDefault, params.limitContext) : '',
        runtimeDefaultBase ?? '',
        staticDefault,
        stripOneMillionSuffix(staticDefault),
      ]) ?? preferredDefault
    );
  }

  const baseModel = stripOneMillionSuffix(selectedModel);
  if (!baseModel) {
    return null;
  }

  const preferredModel = getOneMillionLaunchModel(baseModel, params.limitContext);
  if (availableModels.size === 0) {
    return preferredModel;
  }

  return chooseAvailableModel(availableModels, [preferredModel, baseModel]) ?? preferredModel;
}

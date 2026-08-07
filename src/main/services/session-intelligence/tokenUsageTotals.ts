export interface TokenUsageParts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
}

export function tokenNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolveUsageTotalTokens(
  usage: Record<string, unknown>,
  parts: TokenUsageParts
): number {
  if (usage.total_tokens !== undefined || usage.totalTokens !== undefined) {
    return tokenNumber(usage.total_tokens ?? usage.totalTokens);
  }

  return (
    parts.inputTokens +
    parts.outputTokens +
    parts.cacheReadTokens +
    parts.cacheCreationTokens +
    (parts.reasoningTokens ?? 0)
  );
}

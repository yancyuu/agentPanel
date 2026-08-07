/**
 * Provider launch argument resolver.
 *
 * Converts the provider/runtime fields of a {@link ProviderLaunchInput} (mirrors the
 * relevant subset of `TeamLaunchRequest`) into concrete CLI arguments plus a map of
 * validation issues. This is the pure resolution step that turns "the user picked
 * provider X, model Y, effort Z" into the actual `--model`/`--effort`/... flags the
 * agent CLI understands.
 *
 * It composes the existing provider building blocks rather than reimplementing them:
 * - {@link inferTeamProviderIdFromModel} — infer provider when only a model is known.
 * - {@link migrateProviderBackendId} — normalize/legacy-migrate the backend id.
 * - {@link isTeamEffortLevelForProvider} — validate effort per provider.
 * - {@link resolveAnthropicLaunchModel} — resolve the Anthropic model (incl. `[1m]`
 *   extended-context suffix and `limitContext` behavior).
 * - {@link parseCliArgs} / {@link PROTECTED_CLI_FLAGS} — shell-split + protect the
 *   flags the app manages automatically.
 *
 * The function is pure (no IO) so it is trivially testable.
 */

import { resolveAnthropicLaunchModel } from './anthropicLaunchModel';
import { parseCliArgs } from './cliArgsParser';
import { isTeamEffortLevelForProvider } from './effortLevels';
import { migrateProviderBackendId } from './providerBackend';
import { isDefaultProviderModelSelection } from './providerModelSelection';
import { inferTeamProviderIdFromModel } from './teamProvider';

import type {
  EffortLevel,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface ProviderLaunchInput {
  providerId?: TeamProviderId;
  providerBackendId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  fastMode?: TeamFastMode | null;
  /** When true, limit context window (strips `[1m]` from Anthropic models). */
  limitContext?: boolean;
  /** When true, start a fresh session (no `--resume`). */
  clearContext?: boolean;
  /** When false, run WITHOUT `--dangerously-skip-permissions`. Default: true. */
  skipPermissions?: boolean;
  /** Worktree name → CLI `--worktree <name>`. */
  worktree?: string;
  /** Raw custom CLI args string, shell-split and appended (protected flags dropped). */
  extraCliArgs?: string;
  /** Runtime-known available launch models (used to pick a concrete default). */
  availableLaunchModels?: Iterable<string>;
  /** Runtime-provided default launch model. */
  defaultLaunchModel?: string | null;
}

export interface ProviderLaunchResolution {
  /** Ordered CLI argument tokens to append to the agent command line. */
  providerArgs: string[];
  /** Non-fatal validation problems keyed by a short field name. */
  connectionIssues: Record<string, string>;
  /** The provider id actually used (given or inferred from model). */
  resolvedProviderId: TeamProviderId | undefined;
  /** The migrated/normalized backend id. */
  resolvedProviderBackendId: TeamProviderBackendId | undefined;
  /** The concrete model id to pass to `--model`, or null when none resolved. */
  resolvedModel: string | null;
}

/**
 * Resolve a non-Anthropic provider model. For providers other than Anthropic we do
 * not apply the `[1m]` extended-context convention; we just honor an explicit model
 * selection and return null when the user left it at the provider default.
 */
function resolveNonAnthropicLaunchModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || isDefaultProviderModelSelection(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Resolve provider launch fields into CLI args + validation issues.
 *
 * @example
 * resolveProviderLaunchArgs({ providerId: 'anthropic', model: 'opus', effort: 'high' })
 * // → { providerArgs: ['--model', 'opus[1m]', '--effort', 'high', '--dangerously-skip-permissions'], ... }
 */
export function resolveProviderLaunchArgs(
  input: ProviderLaunchInput = {}
): ProviderLaunchResolution {
  const connectionIssues: Record<string, string> = {};

  // 1. Resolve provider id — explicit wins, otherwise infer from the model.
  const providerId = input.providerId ?? inferTeamProviderIdFromModel(input.model ?? undefined);

  // 2. Migrate/normalize the backend id (handles legacy codex backends).
  const resolvedProviderBackendId = migrateProviderBackendId(
    providerId,
    input.providerBackendId ?? null
  );

  // 3. Resolve the concrete model.
  let resolvedModel: string | null;
  if (providerId === 'anthropic') {
    resolvedModel = resolveAnthropicLaunchModel({
      selectedModel: input.model ?? undefined,
      limitContext: input.limitContext,
      availableLaunchModels: input.availableLaunchModels,
      defaultLaunchModel: input.defaultLaunchModel ?? null,
    });
  } else {
    resolvedModel = resolveNonAnthropicLaunchModel(input.model ?? null);
  }

  // 4. Validate effort against the resolved provider.
  const effort = input.effort ?? null;
  // Capture the raw effort string before the type guard: in the guard's false
  // branch `effort` narrows to `never`, so we need a stable value for the message.
  const effortValue = effort ?? '';
  let resolvedEffort: EffortLevel | null = null;
  if (effort) {
    if (isTeamEffortLevelForProvider(effort, providerId)) {
      resolvedEffort = effort;
    } else {
      connectionIssues.effort = `Effort "${effortValue}" is not valid for provider "${
        providerId ?? 'unknown'
      }"; dropped.`;
    }
  }

  // 5. Build the ordered CLI args. Track the flags we actually emit so the
  // extra-args merge (step 6) only drops genuine conflicts.
  const providerArgs: string[] = [];
  const emittedValueFlags = new Set<string>();
  const emittedBooleanFlags = new Set<string>();

  if (resolvedModel) {
    providerArgs.push('--model', resolvedModel);
    emittedValueFlags.add('--model');
  } else if (providerId === 'codex') {
    // Codex requires an explicit model to launch deterministically.
    connectionIssues.model =
      'Codex provider has no resolved model; the runtime default will be used.';
  }

  if (resolvedEffort) {
    providerArgs.push('--effort', resolvedEffort);
    emittedValueFlags.add('--effort');
  }

  // skipPermissions defaults to true at the launch layer (see TeamLaunchRequest),
  // but this resolver is a low-level primitive also used for non-launch commands
  // (e.g. `claude mcp list`). We therefore emit --dangerously-skip-permissions only
  // when the caller explicitly opts in, keeping the MCP diagnostic path unaffected.
  if (input.skipPermissions === true) {
    providerArgs.push('--dangerously-skip-permissions');
    emittedBooleanFlags.add('--dangerously-skip-permissions');
  }

  const worktree = input.worktree?.trim();
  if (worktree) {
    providerArgs.push('--worktree', worktree);
    emittedValueFlags.add('--worktree');
  }

  // 6. Merge extra CLI args, dropping duplicates of flags we already emitted.
  // Value-taking emitted flags drop both the flag and its following value token;
  // boolean emitted flags drop only the flag itself. Flags we did NOT emit are
  // always preserved (the user's explicit choice stands).
  const extraRaw = input.extraCliArgs?.trim();
  if (extraRaw) {
    const tokens = parseCliArgs(extraRaw);
    let recordedConflict = false;
    const noteConflict = (token: string): void => {
      if (!recordedConflict) {
        connectionIssues.extraCliArgs = `Custom CLI args included a managed flag ("${token}") that conflicts with provider settings; dropped.`;
        recordedConflict = true;
      }
    };
    // Walk the tokens with a skip-next flag so we never mutate the loop counter
    // (value-flag conflicts drop both the flag and its following value token).
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (emittedValueFlags.has(token)) {
        noteConflict(token);
        skipNext = true;
        continue;
      }
      if (emittedBooleanFlags.has(token)) {
        noteConflict(token);
        continue;
      }
      providerArgs.push(token);
    }
  }

  // clearContext is informational here: it tells the launcher NOT to add --resume.
  // We surface it as a resolved flag rather than an arg so callers can branch on it.
  if (input.clearContext) {
    // No arg emitted; consumed by the launcher when deciding whether to add --resume.
  }

  return {
    providerArgs,
    connectionIssues,
    resolvedProviderId: providerId,
    resolvedProviderBackendId,
    resolvedModel,
  };
}

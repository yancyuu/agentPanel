import { describe, expect, it } from 'vitest';

import { resolveProviderLaunchArgs } from '../providerLaunchArgs';

describe('resolveProviderLaunchArgs', () => {
  describe('model resolution', () => {
    it('appends the [1m] suffix to opus for Anthropic by default', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        effort: 'high',
        skipPermissions: true,
      });
      expect(result.resolvedModel).toBe('opus[1m]');
      expect(result.providerArgs).toEqual([
        '--model',
        'opus[1m]',
        '--effort',
        'high',
        '--dangerously-skip-permissions',
      ]);
    });

    it('strips the [1m] suffix when limitContext is set', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        effort: 'high',
        limitContext: true,
      });
      expect(result.resolvedModel).toBe('opus');
      expect(result.providerArgs).toContain('--model');
      expect(result.providerArgs).not.toContain('opus[1m]');
    });

    it('does not add [1m] to models that do not support it (haiku)', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'haiku',
      });
      expect(result.resolvedModel).toBe('haiku');
    });

    it('passes an explicit model through for non-Anthropic providers', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'gemini',
        model: 'gemini-2.5-pro',
      });
      expect(result.resolvedModel).toBe('gemini-2.5-pro');
      expect(result.providerArgs).toContain('gemini-2.5-pro');
    });

    it('drops the model arg when a non-Anthropic provider uses the default sentinel', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'gemini',
        model: '__provider_default__',
      });
      expect(result.resolvedModel).toBeNull();
      expect(result.providerArgs).not.toContain('--model');
    });

    it('infers the provider id from the model when none is given', () => {
      const result = resolveProviderLaunchArgs({ model: 'gemini-2.5-pro' });
      expect(result.resolvedProviderId).toBe('gemini');
    });

    it('reports an issue when Codex has no resolved model', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'codex',
        model: '__provider_default__',
      });
      expect(result.resolvedModel).toBeNull();
      expect(result.connectionIssues.model).toMatch(/Codex/);
    });
  });

  describe('effort validation', () => {
    it('keeps effort valid for the provider', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        effort: 'max',
      });
      expect(result.providerArgs).toContain('--effort');
      expect(result.providerArgs).toContain('max');
    });

    it('drops effort that is invalid for the provider and records an issue', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        effort: 'minimal', // minimal is not valid for anthropic
      });
      expect(result.providerArgs).not.toContain('--effort');
      expect(result.connectionIssues.effort).toMatch(/minimal/);
    });

    it('accepts minimal effort for Codex', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'codex',
        model: 'gpt-5.2',
        effort: 'minimal',
      });
      expect(result.providerArgs).toContain('minimal');
    });
  });

  describe('permissions and worktree', () => {
    it('adds --dangerously-skip-permissions only when explicitly opted in', () => {
      const withFlag = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        skipPermissions: true,
      });
      expect(withFlag.providerArgs).toContain('--dangerously-skip-permissions');

      // No opt-in (e.g. the MCP diagnostic path) → flag is NOT added.
      const noOptIn = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
      });
      expect(noOptIn.providerArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('omits --dangerously-skip-permissions when skipPermissions is false', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        skipPermissions: false,
      });
      expect(result.providerArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('appends --worktree when a worktree name is given', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        worktree: 'feature-x',
      });
      expect(result.providerArgs).toContain('--worktree');
      expect(result.providerArgs).toContain('feature-x');
    });
  });

  describe('extra CLI args', () => {
    it('appends shell-split custom args', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        extraCliArgs: '--verbose --max-turns 5',
      });
      expect(result.providerArgs).toContain('--verbose');
      expect(result.providerArgs).toContain('--max-turns');
      expect(result.providerArgs).toContain('5');
    });

    it('drops a conflicting value flag AND its value from extra args', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        extraCliArgs: '--model gpt-4 --verbose',
      });
      // The emitted --model opus[1m] stays (exactly once); the user's --model gpt-4
      // and its value are dropped as a conflict.
      expect(result.providerArgs.filter((a) => a === '--model')).toHaveLength(1);
      expect(result.providerArgs).toContain('opus[1m]');
      expect(result.providerArgs).not.toContain('gpt-4');
      expect(result.providerArgs).toContain('--verbose');
      expect(result.connectionIssues.extraCliArgs).toMatch(/--model/);
    });

    it('drops a conflicting boolean flag from extra args', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        skipPermissions: true,
        extraCliArgs: '--dangerously-skip-permissions --verbose',
      });
      expect(result.connectionIssues.extraCliArgs).toMatch(/--dangerously-skip-permissions/);
      // only one --dangerously-skip-permissions should remain (the one we emit)
      const count = result.providerArgs.filter(
        (a) => a === '--dangerously-skip-permissions'
      ).length;
      expect(count).toBe(1);
    });

    it('preserves an unmanaged flag the resolver did not emit', () => {
      // No skipPermissions → the resolver does not emit --dangerously-skip-permissions,
      // so the user's explicit copy must be preserved (not treated as a conflict).
      const result = resolveProviderLaunchArgs({
        providerId: 'anthropic',
        model: 'opus',
        extraCliArgs: '--dangerously-skip-permissions --verbose',
      });
      expect(result.connectionIssues.extraCliArgs).toBeUndefined();
      expect(result.providerArgs).toContain('--dangerously-skip-permissions');
    });
  });

  describe('backend migration', () => {
    it('migrates legacy Codex backend to codex-native', () => {
      const result = resolveProviderLaunchArgs({
        providerId: 'codex',
        model: 'gpt-5.2',
        providerBackendId: 'auto',
      });
      expect(result.resolvedProviderBackendId).toBe('codex-native');
    });
  });

  describe('empty input', () => {
    it('returns empty args and issues with no provider info', () => {
      const result = resolveProviderLaunchArgs();
      expect(result.providerArgs).toEqual([]);
      expect(result.connectionIssues).toEqual({});
      expect(result.resolvedProviderId).toBeUndefined();
      expect(result.resolvedModel).toBeNull();
    });
  });
});

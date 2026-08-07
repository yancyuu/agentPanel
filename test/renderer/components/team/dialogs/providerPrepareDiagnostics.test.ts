import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderPrepareModelCheckingLine,
  buildReusableProviderPrepareModelResults,
  getProviderPrepareCachedSnapshot,
  runProviderPrepareDiagnostics,
} from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';

import type { TeamProviderId, TeamProvisioningPrepareResult } from '@shared/types';

describe('providerPrepareDiagnostics (sidecar only)', () => {
  it('保留可复用模型结果（不再做本地过滤）', () => {
    expect(
      buildReusableProviderPrepareModelResults({
        'gpt-5.5': { status: 'ready', line: 'ok' },
        'gpt-5.4': { status: 'notes', line: 'note' },
      })
    ).toEqual({
      'gpt-5.5': { status: 'ready', line: 'ok' },
      'gpt-5.4': { status: 'notes', line: 'note' },
    });
  });

  it('缓存快照会给未命中的模型展示 checking', () => {
    const snapshot = getProviderPrepareCachedSnapshot({
      providerId: 'codex',
      selectedModelIds: ['gpt-5.5', 'gpt-5.4'],
      cachedModelResultsById: {
        'gpt-5.5': { status: 'ready', line: '5.5 - verified' },
      },
    });

    expect(snapshot.status).toBe('checking');
    expect(snapshot.completedCount).toBe(1);
    expect(snapshot.totalCount).toBe(2);
    expect(snapshot.details[1]).toContain('checking');
  });

  it('sidecar 返回失败时，按模型输出失败结果', async () => {
    const prepareProvisioning = vi
      .fn<
        (
          cwd?: string,
          providerId?: TeamProviderId
        ) => Promise<TeamProvisioningPrepareResult>
      >()
      .mockResolvedValue({
        ready: false,
        message: 'Sidecar unavailable',
        details: ['model gpt-5.5 not available'],
      });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/workspace',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.5'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.modelResultsById['gpt-5.5']?.status).toBe('failed');
    expect(result.details.join('\n')).toContain('sidecar check failed');
  });

  it('sidecar 返回 ready 时，模型标记 verified', async () => {
    const prepareProvisioning = vi
      .fn<
        (
          cwd?: string,
          providerId?: TeamProviderId
        ) => Promise<TeamProvisioningPrepareResult>
      >()
      .mockResolvedValue({
        ready: true,
        message: '',
        details: ['provider ready'],
      });

    const progress: string[] = [];
    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/workspace',
      providerId: 'anthropic',
      selectedModelIds: [DEFAULT_PROVIDER_MODEL_SELECTION],
      prepareProvisioning,
      onModelProgress: ({ status }) => progress.push(status),
    });

    expect(buildProviderPrepareModelCheckingLine('anthropic', DEFAULT_PROVIDER_MODEL_SELECTION)).toContain(
      '默认'
    );
    expect(progress[0]).toBe('checking');
    expect(result.status).toBe('ready');
    expect(Object.values(result.modelResultsById)[0]?.line).toContain('verified');
  });
});

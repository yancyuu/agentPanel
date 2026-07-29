import { describe, expect, it } from 'vitest';

import { buildWorkbenchRuntimeEnv, resolveLoopbackWorkbenchUrl } from './workbenchRuntimeEnv';

describe('Workbench runtime environment', () => {
  it('normalizes wildcard listeners to a loopback URL', () => {
    expect(resolveLoopbackWorkbenchUrl('0.0.0.0', 5681)).toBe('http://127.0.0.1:5681');
    expect(resolveLoopbackWorkbenchUrl('::', 5681)).toBe('http://127.0.0.1:5681');
    expect(resolveLoopbackWorkbenchUrl('::1', 5681)).toBe('http://[::1]:5681');
  });

  it('preserves caller values while adding the managed PATH and Workbench endpoint', () => {
    const env = buildWorkbenchRuntimeEnv({
      workbenchUrl: 'http://127.0.0.1:5681',
      baseEnv: { PROVIDER_KEY: 'secret' },
    });

    expect(env).toEqual(
      expect.objectContaining({
        PROVIDER_KEY: 'secret',
        HERMIT_WORKBENCH_URL: 'http://127.0.0.1:5681',
        PATH: expect.any(String),
      })
    );
  });
});

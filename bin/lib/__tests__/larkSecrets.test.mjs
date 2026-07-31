import { describe, expect, it } from 'vitest';

import { reportAllLarkCredentials } from '../larkSecrets.mjs';

function makeFakeChild({ stdout = '{}', code = 0, stderr = '' } = {}) {
  const handlers = {};
  const emitter = {
    stdout: {
      on: (event, cb) => {
        if (event === 'data') process.nextTick(() => cb(stdout));
      },
    },
    stderr: {
      on: (event, cb) => {
        if (event === 'data' && stderr) process.nextTick(() => cb(stderr));
      },
    },
    on: (event, cb) => {
      handlers[event] = cb;
      if (event === 'close') process.nextTick(() => cb(code));
    },
    pid: 12345,
    killed: false,
  };
  return emitter;
}

describe('reportAllLarkCredentials MJS bridge', () => {
  it('spawns the TSX worker --report-lark-credentials-once child and returns its parsed JSON', async () => {
    let capturedArgs;
    const spawnImpl = (node, args) => {
      capturedArgs = args;
      return makeFakeChild({
        stdout: JSON.stringify({
          ok: true,
          accountCount: 2,
          lastAttemptAt: '2026-07-16T00:00:00.000Z',
        }),
      });
    };
    const result = await reportAllLarkCredentials({ spawnImpl, repoRoot: '/tmp/repo' });

    // Routes through the worker child, never reimplements batch reporting in MJS.
    expect(capturedArgs).toContain('--report-lark-credentials-once');
    expect(
      capturedArgs.some(
        (a) => String(a).endsWith('worker.ts') || String(a).endsWith('telemetry-worker.bundle.mjs')
      )
    ).toBe(true);
    expect(result).toMatchObject({ ok: true, accountCount: 2 });
  });

  it('returns a sanitized failure status when the child emits invalid JSON', async () => {
    const result = await reportAllLarkCredentials({
      spawnImpl: () => makeFakeChild({ stdout: 'not-json', code: 0 }),
      repoRoot: '/tmp/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fetch-failed');
  });

  it('returns a sanitized failure status when the child exits non-zero', async () => {
    const result = await reportAllLarkCredentials({
      spawnImpl: () => makeFakeChild({ stdout: '{}', code: 2, stderr: 'boom' }),
      repoRoot: '/tmp/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fetch-failed');
    // Raw child stderr must not leak verbatim into the returned diagnostic.
    expect(JSON.stringify(result)).not.toContain('boom');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getValidBearerToken } from '@main/services/auth/OpenHermitAuthClient';

const temporaryDirectories: string[] = [];

async function makeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-client-test-'));
  temporaryDirectories.push(home);
  return home;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('OpenHermitAuthClient worker 刷新写穿透', () => {
  it('刷新成功后把新 token 写到 App 默认连接 secret', async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, 'auth'), { recursive: true });
    await fs.writeFile(
      path.join(home, 'auth', 'openhermit.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'openhermit',
        issuer: 'https://agentbus.skg.com',
        baseUrl: 'https://agentbus.skg.com',
        account: { id: 'u-1' },
        token: {
          accessToken: 'at-old',
          refreshToken: 'rt-old',
          tokenType: 'Bearer',
          expiresAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/api/v1/auth/refresh');
        return new Response(
          JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const token = await getValidBearerToken(home);
    expect(token).toBe('at-new');

    // 写穿透：默认连接 record 已认证 + secret 是新 token
    const index = JSON.parse(
      await fs.readFile(path.join(home, 'connections', 'index.json'), 'utf8')
    ) as { connections: Record<string, never>[] };
    expect(index.connections[0]).toMatchObject({ state: 'authenticated' });
    const connectionId = index.connections[0]?.id as string;
    const secret = JSON.parse(
      await fs.readFile(path.join(home, 'connections', 'secrets', `${connectionId}.json`), 'utf8')
    ) as Record<string, unknown>;
    expect(secret).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
  });
});

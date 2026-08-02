import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SystemCredentialSecretStore } from '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

async function makeStore(): Promise<{ dir: string; store: SystemCredentialSecretStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-secrets-'));
  temporaryDirectories.push(dir);
  return { dir, store: new SystemCredentialSecretStore(dir) };
}

const LONG_SECRET = JSON.stringify({
  schemaVersion: 1,
  connectionId: 'connection_1234567890abcdef',
  providerId: 'openhermit-agentbus',
  issuerOrigin: 'http://47.112.24.153',
  accessToken: `at_${'x'.repeat(400)}`,
  refreshToken: `rt_${'y'.repeat(200)}`,
  tokenType: 'Bearer',
  scopes: ['identity:read'],
  updatedAt: '2026-01-01T00:00:00.000Z',
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('SystemCredentialSecretStore（文件后端）', () => {
  it('写入并读回完整的长 secret（不再截断），文件权限为 0600', async () => {
    const { dir, store } = await makeStore();
    await store.put('connection_1234567890abcdef', LONG_SECRET);

    expect(LONG_SECRET.length).toBeGreaterThan(128);
    expect(await store.get('connection_1234567890abcdef')).toBe(LONG_SECRET);

    const stat = await fs.stat(path.join(dir, 'connection_1234567890abcdef.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('覆盖写入仍是完整内容且权限保持 0600', async () => {
    const { dir, store } = await makeStore();
    await store.put('connection_1', LONG_SECRET);
    // 人为放宽权限后覆盖写，rename 后应被收敛回 0600
    await fs.chmod(path.join(dir, 'connection_1.json'), 0o644);
    const next = JSON.stringify({ accessToken: 'next' });
    await store.put('connection_1', next);

    expect(await store.get('connection_1')).toBe(next);
    const stat = await fs.stat(path.join(dir, 'connection_1.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('has/delete 基于文件存在性；损坏 JSON 读出返回 null', async () => {
    const { dir, store } = await makeStore();
    expect(await store.has('connection_1')).toBe(false);

    await store.put('connection_1', LONG_SECRET);
    expect(await store.has('connection_1')).toBe(true);

    await fs.writeFile(path.join(dir, 'connection_1.json'), LONG_SECRET.slice(0, 100));
    expect(await store.get('connection_1')).toBeNull();

    await store.delete('connection_1');
    expect(await store.has('connection_1')).toBe(false);
    // 删除不存在不报错
    await store.delete('connection_1');
  });

  it('拒绝非法连接标识（路径穿越防护）', async () => {
    const { store } = await makeStore();
    await expect(store.put('../etc/passwd', '{}')).rejects.toThrow('连接标识格式无效');
    await expect(store.get('a/b')).rejects.toThrow('连接标识格式无效');
  });
});

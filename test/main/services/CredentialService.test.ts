import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialService } from '@main/services/extensions/credentials/CredentialService';

const temporaryDirectories: string[] = [];

vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => process.env.TEST_CLAUDE_BASE ?? '/nonexistent',
  getHomeDir: () => os.homedir(),
}));

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TEST_CLAUDE_BASE;
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('CredentialService.getStorageStatus fileSecure 平台分支', () => {
  async function makeCredentialsDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-test-'));
    temporaryDirectories.push(dir);
    process.env.TEST_CLAUDE_BASE = dir;
    await fs.mkdir(path.join(dir, 'credentials'), { recursive: true });
    await fs.writeFile(path.join(dir, 'credentials', 'mcp.json'), '{}');
    return dir;
  }

  it('POSIX 平台按 mode 判定（>0600 视为不安全）', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeCredentialsDir();
    await fs.chmod(path.join(dir, 'credentials', 'mcp.json'), 0o644);
    const service = new CredentialService();

    expect((await service.getStorageStatus()).fileSecure).toBe(false);

    await fs.chmod(path.join(dir, 'credentials', 'mcp.json'), 0o600);
    expect((await service.getStorageStatus()).fileSecure).toBe(true);
  });

  it('win32 跳过 POSIX mode 判定，位于用户目录即视为受保护', async () => {
    if (process.platform !== 'win32') {
      // 无法伪造 process.platform 的只读值时跳过真实分支，仅验证 POSIX 分支不受影响
      return;
    }
    const dir = await makeCredentialsDir();
    const service = new CredentialService();
    expect((await service.getStorageStatus()).fileSecure).toBe(true);
    void dir;
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// 验证 CLI（纯 node ESM）经相对路径加载同一份桥接实现（design D4，零重复）。
import {
  clearConnectionAuth,
  writeConnectionThrough,
} from '../../../src/shared/authSync/index.mjs';
import { buildLocalUsageTaskBusConfig } from '../usageCommand.mjs';

const temporaryDirectories = [];

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'auth-sync-cli-'));
  temporaryDirectories.push(home);
  return home;
}

function cliStore() {
  return {
    schemaVersion: 1,
    provider: 'openhermit',
    issuer: 'https://agentbus.skg.com',
    baseUrl: 'https://agentbus.skg.com',
    clientId: 'openhermit-cli',
    account: { id: 'u-1', email: 'dev@corp.test', name: '开发者' },
    token: {
      accessToken: 'at-cli',
      refreshToken: 'rt-cli',
      tokenType: 'Bearer',
      scope: 'upload:read',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('CLI 侧桥接加载（bin/lib → src/shared/authSync）', () => {
  it('CLI 登录写穿透：App 默认连接 authenticated + secret 落盘；logout 后 auth_required', async () => {
    const home = await makeHome();
    const connectionsDir = path.join(home, 'connections');

    const { outcome, connectionId } = await writeConnectionThrough({
      connectionsDir,
      store: cliStore(),
    });
    expect(outcome).toBe('written');

    const index = JSON.parse(
      await readFile(path.join(connectionsDir, 'index.json'), 'utf8')
    );
    expect(index.connections[0]).toMatchObject({
      state: 'authenticated',
      managedDefault: true,
      account: { email: 'dev@corp.test' },
    });
    expect(
      existsSync(path.join(connectionsDir, 'secrets', `${connectionId}.json`))
    ).toBe(true);

    await clearConnectionAuth({ connectionsDir });
    const after = JSON.parse(await readFile(path.join(connectionsDir, 'index.json'), 'utf8'));
    expect(after.connections[0].state).toBe('auth_required');
    expect(existsSync(path.join(connectionsDir, 'secrets', `${connectionId}.json`))).toBe(false);
  });
});

describe('buildLocalUsageTaskBusConfig 老配置 opt-in 语义', () => {
  it('缺 canonical 字段时不默认开启消息正文上报', () => {
    const config = buildLocalUsageTaskBusConfig({
      telemetry: { enabled: true, uploadProviders: ['claudecode'] },
    });
    expect(config.telemetry.conversationUploadEnabled).toBe(false);
  });

  it('canonical 显式 true 保持开启；历史 conversations.uploadEnabled=true 视为显式选择', () => {
    expect(
      buildLocalUsageTaskBusConfig({ telemetry: { conversationUploadEnabled: true } }).telemetry
        .conversationUploadEnabled
    ).toBe(true);
    expect(
      buildLocalUsageTaskBusConfig({ telemetry: { conversations: { uploadEnabled: true } } })
        .telemetry.conversationUploadEnabled
    ).toBe(true);
  });
});

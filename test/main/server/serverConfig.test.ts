import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHermitConfigStore, createServerEnvironment } from '../../../src/main/serverConfig';

const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function createTestHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'agentpanel-server-config-'));
  temporaryHomes.push(home);
  return home;
}

describe('createHermitConfigStore external channel lifecycle', () => {
  it('does not create cc-connect configuration while the integration is disabled', () => {
    const homeDir = createTestHome();
    const environment = createServerEnvironment({
      startDir: process.cwd(),
      homeDir,
      env: {},
    });

    expect(environment.ccConnectEnabled).toBe(false);
    createHermitConfigStore(environment, {}).load();
    expect(existsSync(environment.hermitBridgeConfigFile)).toBe(false);
  });

  it('rejects external management listeners and invalid ports when saving cc-connect config', async () => {
    const homeDir = createTestHome();
    const settingsPath = path.join(homeDir, '.hermit', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ externalChannels: { ccConnect: { enabled: true } } }),
      'utf8'
    );
    const environment = createServerEnvironment({ startDir: process.cwd(), homeDir, env: {} });
    const store = createHermitConfigStore(environment, {});

    await expect(
      Promise.resolve().then(() =>
        store.writeBridgeRaw('[management]\nhost = "0.0.0.0"\nport = 9820\ntoken = "safe"\n')
      )
    ).rejects.toThrow('本机回环地址');
    await expect(
      Promise.resolve().then(() =>
        store.writeBridgeRaw('[bridge]\nhost = "127.0.0.1"\nport = 99999\ntoken = "safe"\n')
      )
    ).rejects.toThrow('端口必须在 1 到 65535');
  });

  it('provisions a tokenized local cc-connect configuration only after explicit enablement', () => {
    const homeDir = createTestHome();
    const settingsPath = path.join(homeDir, '.hermit', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ externalChannels: { ccConnect: { enabled: true } } }),
      'utf8'
    );
    const environment = createServerEnvironment({
      startDir: process.cwd(),
      homeDir,
      env: {},
    });

    const config = createHermitConfigStore(environment, {}).load();
    const raw = readFileSync(environment.hermitBridgeConfigFile, 'utf8');

    expect(environment.ccConnectEnabled).toBe(true);
    expect(raw).toContain('[management]');
    expect(raw).toContain('[bridge]');
    expect(raw).toContain(`data_dir = "${environment.hermitBridgeDataDir}"`);
    expect(config.ccToken).toMatch(/^[a-f0-9]{48}$/u);
    expect(config.ccBridgeToken).toMatch(/^[a-f0-9]{48}$/u);
  });
});

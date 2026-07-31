import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function importAuthWithHome(home) {
  vi.resetModules();
  process.env.HERMIT_HOME = home;
  return import('../auth.mjs');
}

describe('auth cloud base URL resolution', () => {
  const previousEnv = { ...process.env };
  let tmpHome;

  afterEach(async () => {
    process.env = { ...previousEnv };
    vi.resetModules();
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  });

  it('uses the canonical HTTPS AgentBus domain for a fresh installation', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));

    const auth = await importAuthWithHome(tmpHome);

    expect(auth.OPENHERMIT_AUTH_BROKER_URL).toBe('https://agentbus.skg.com');
    expect(auth.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL).toBe('https://agentbus.skg.com');
  });

  it.each([
    'http://47.112.24.153',
    'http://159.75.231.98:8088',
  ])('migrates the legacy product default %s to the HTTPS AgentBus domain', async (legacyBaseUrl) => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));
    await mkdir(path.join(tmpHome, 'auth'), { recursive: true });
    await writeFile(
      path.join(tmpHome, 'settings.json'),
      JSON.stringify({ taskBus: { telemetry: { conversations: { baseUrl: legacyBaseUrl } } } })
    );
    await writeFile(
      path.join(tmpHome, 'auth', 'openhermit.json'),
      JSON.stringify({ issuer: legacyBaseUrl, baseUrl: legacyBaseUrl, token: { accessToken: 'tok' } })
    );

    const auth = await importAuthWithHome(tmpHome);

    expect(auth.OPENHERMIT_AUTH_BROKER_URL).toBe('https://agentbus.skg.com');
    expect(auth.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL).toBe('https://agentbus.skg.com');
    expect(auth.resolveConversationUploadBaseUrl(legacyBaseUrl)).toBe('https://agentbus.skg.com');
  });

  it('preserves an explicitly configured custom cloud domain', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));
    await mkdir(tmpHome, { recursive: true });
    await writeFile(
      path.join(tmpHome, 'settings.json'),
      JSON.stringify({ cloud: { baseUrl: 'https://custom-agentbus.example.test/' } })
    );

    const auth = await importAuthWithHome(tmpHome);

    expect(auth.OPENHERMIT_AUTH_BROKER_URL).toBe('https://custom-agentbus.example.test');
  });

  it('prefers settings.cloud.baseUrl for auth and report base URLs', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));
    await mkdir(tmpHome, { recursive: true });
    await writeFile(
      path.join(tmpHome, 'settings.json'),
      JSON.stringify({ cloud: { baseUrl: 'https://monitor.example.test:9443/' } })
    );

    const auth = await importAuthWithHome(tmpHome);

    expect(auth.OPENHERMIT_AUTH_BROKER_URL).toBe('https://monitor.example.test:9443');
    expect(auth.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL).toBe('https://monitor.example.test:9443');
    expect(auth.resolveConversationUploadBaseUrl('http://stale.example.test:8088')).toBe(
      'https://monitor.example.test:9443'
    );
  });

  it('falls back to the saved auth baseUrl before stale conversation settings', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));
    await mkdir(path.join(tmpHome, 'auth'), { recursive: true });
    await writeFile(
      path.join(tmpHome, 'settings.json'),
      JSON.stringify({ taskBus: { telemetry: { conversations: { baseUrl: 'http://stale.example.test:8088' } } } })
    );
    await writeFile(
      path.join(tmpHome, 'auth', 'openhermit.json'),
      JSON.stringify({
        issuer: 'http://issuer.example.test:8088',
        baseUrl: 'http://auth-base.example.test:8088',
        token: { accessToken: 'tok' },
      })
    );

    const auth = await importAuthWithHome(tmpHome);

    expect(auth.resolveConversationUploadBaseUrl('http://stale.example.test:8088')).toBe(
      'http://auth-base.example.test:8088'
    );
  });

  it('lets OPENHERMIT_CLOUD_HOST override a stale saved issuer', async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-auth-base-'));
    await mkdir(path.join(tmpHome, 'auth'), { recursive: true });
    await writeFile(
      path.join(tmpHome, 'auth', 'openhermit.json'),
      JSON.stringify({ issuer: 'http://stale-issuer.example.test:8088', token: { accessToken: 'tok' } })
    );
    process.env.OPENHERMIT_CLOUD_HOST = 'fresh-host.example.test';

    const auth = await importAuthWithHome(tmpHome);

    // Host-only overrides inherit the secure protocol from the canonical default.
    expect(auth.OPENHERMIT_AUTH_BROKER_URL).toBe('https://fresh-host.example.test');
    expect(auth.OPENHERMIT_CONVERSATION_UPLOAD_BASE_URL).toBe('https://fresh-host.example.test');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHermitConfigStore, createServerEnvironment } from '../../../src/main/serverConfig';
import {
  createStandaloneServerComposition,
  getOrCreateStandaloneServerComposition,
} from '../../../src/main/serverComposition';
import { startStandaloneServer } from '../../../src/main/serverStandalone';
import { createWorkbenchServer } from '../../../src/main/workbenchServer';
import { methodCounts, sortedRouteKeys } from './routeManifestBaseline';

const tempDirectories: string[] = [];

async function createHarness(overrides: Record<string, string> = {}) {
  const hermitHome = await mkdtemp(path.join(os.tmpdir(), 'hermit-server-factory-'));
  tempDirectories.push(hermitHome);
  const environment = createServerEnvironment({
    startDir: path.resolve(process.cwd(), 'src/main'),
    homeDir: hermitHome,
    env: {
      HERMIT_HOME: hermitHome,
      STATIC_DIR: path.join(hermitHome, 'missing-static'),
      HERMIT_BRIDGE_TOKEN: 'management-token',
      CC_CONNECT_BRIDGE_TOKEN: 'bridge-token',
      ...overrides,
    },
  });
  const configStore = createHermitConfigStore(environment, {
    HERMIT_HOME: hermitHome,
    HERMIT_BRIDGE_TOKEN: 'management-token',
    CC_CONNECT_BRIDGE_TOKEN: 'bridge-token',
  });
  const composition = createStandaloneServerComposition(environment, configStore);
  return { environment, configStore, composition };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('workbench server factory', () => {
  it('constructs and registers the app without listening', async () => {
    const harness = await createHarness();
    const app = Fastify({ logger: false });
    const listen = vi.spyOn(app, 'listen');

    const server = await createWorkbenchServer(harness.composition.context, {
      environment: harness.environment,
      configStore: harness.configStore,
      getRuntimeConfig: harness.composition.getRuntimeConfig,
      updateRuntimeConfig: harness.composition.updateRuntimeConfig,
      setRestartBridge: harness.composition.setRestartBridge,
      appFactory: () => app,
    });

    expect(server.app).toBe(app);
    expect(listen).not.toHaveBeenCalled();
    expect(app.hasRoute({ method: 'GET', url: '/api/teams' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/events' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/extensions/plugins' })).toBe(true);

    const trusted = await app.inject({ method: 'GET', url: '/api/version' });
    const rejected = await app.inject({
      method: 'GET',
      url: '/api/version',
      headers: { origin: 'https://malicious.example' },
    });
    expect(trusted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ ok: false, error: 'Forbidden origin' });
    await server.shutdown();
  });

  it('requires the per-launch desktop session token and exposes an independent health check', async () => {
    const harness = await createHarness({ AGENTPANEL_DESKTOP_SESSION_TOKEN: 'desktop-secret' });
    const server = await createWorkbenchServer(harness.composition.context, {
      environment: harness.environment,
      configStore: harness.configStore,
      getRuntimeConfig: harness.composition.getRuntimeConfig,
      updateRuntimeConfig: harness.composition.updateRuntimeConfig,
      setRestartBridge: harness.composition.setRestartBridge,
    });

    expect((await server.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { 'x-agentpanel-desktop-token': 'wrong' },
        })
      ).statusCode
    ).toBe(401);
    const healthy = await server.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-agentpanel-desktop-token': 'desktop-secret' },
    });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual({
      ok: true,
      service: 'agentpanel-workbench',
      version: harness.environment.version,
    });
    await server.shutdown();
  });

  it('assembles the complete checked static method/path manifest at runtime', async () => {
    const harness = await createHarness();
    const runtimeRoutes: string[] = [];
    const allMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    const server = await createWorkbenchServer(harness.composition.context, {
      environment: harness.environment,
      configStore: harness.configStore,
      getRuntimeConfig: harness.composition.getRuntimeConfig,
      updateRuntimeConfig: harness.composition.updateRuntimeConfig,
      setRestartBridge: harness.composition.setRestartBridge,
      fastifyOptions: { logger: false },
      onRoute: ({ method, url }) => {
        const methods = Array.isArray(method) ? method : [method];
        const normalized = new Set(methods.map((entry) => entry.toUpperCase()));
        if ([...allMethods].every((entry) => normalized.has(entry))) {
          runtimeRoutes.push(`ALL ${url}`);
          return;
        }
        for (const entry of normalized) {
          if (entry !== 'HEAD' && entry !== 'OPTIONS') runtimeRoutes.push(`${entry} ${url}`);
        }
      },
    });

    const expectedRoutes = sortedRouteKeys();
    const actualRoutes = [...runtimeRoutes].sort((left, right) => left.localeCompare(right));

    expect(actualRoutes).toHaveLength(expectedRoutes.length);
    expect(new Set(actualRoutes).size).toBe(expectedRoutes.length);
    expect(actualRoutes).toEqual(expectedRoutes);
    expect(methodCounts(actualRoutes)).toEqual(methodCounts(expectedRoutes));
    await server.shutdown();
  });

  it('returns one app and one listener set for the same context', async () => {
    const harness = await createHarness();
    const options = {
      environment: harness.environment,
      configStore: harness.configStore,
      getRuntimeConfig: harness.composition.getRuntimeConfig,
      updateRuntimeConfig: harness.composition.updateRuntimeConfig,
      setRestartBridge: harness.composition.setRestartBridge,
      fastifyOptions: { logger: false as const },
    };

    const first = await createWorkbenchServer(harness.composition.context, options);
    const second = await createWorkbenchServer(harness.composition.context, options);

    expect(second).toBe(first);
    expect(harness.composition.context.services.bridgeConnection.listenerCount('reply')).toBe(1);
    expect(
      harness.composition.context.services.bridgeConnection.listenerCount('reply_stream')
    ).toBe(1);
    expect(harness.composition.context.services.bridgeConnection.listenerCount('message')).toBe(1);
    // 现有 bridge 生命周期监听器仅管理本地 Direct CLI 会话。
    expect(harness.composition.context.lifecycle.listenerDisposers).toHaveLength(4);
    await first.shutdown();
  });

  it('reuses one production standalone composition per process', async () => {
    const harness = await createHarness();
    const first = getOrCreateStandaloneServerComposition(harness.environment, harness.configStore);
    const second = getOrCreateStandaloneServerComposition(harness.environment, harness.configStore);

    expect(second).toBe(first);
    expect(second.context).toBe(first.context);
  });

  it('passes explicit standalone startup options without creating a second context', async () => {
    const harness = await createHarness({ HOST: '127.0.0.9', PORT: '6199' });
    const startRuntime = vi.fn(() => Promise.resolve(undefined));

    const handle = await startStandaloneServer({
      environment: harness.environment,
      composition: harness.composition,
      installProcessHandlers: false,
      startRuntime,
    });
    const secondHandle = await startStandaloneServer({
      environment: harness.environment,
      composition: harness.composition,
      installProcessHandlers: false,
      startRuntime,
    });

    expect(handle.context).toBe(harness.composition.context);
    expect(secondHandle.app).toBe(handle.app);
    expect(startRuntime).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.9',
        port: 6199,
        staticDir: harness.environment.staticDir,
        bridgeConfigPath: harness.environment.hermitBridgeConfigFile,
      })
    );
    await handle.shutdown();
  });
});

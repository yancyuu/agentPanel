import { describe, expect, it, vi } from 'vitest';

import {
  createServerContext,
  createServerRuntimeState,
  type ServerServices,
} from '../../../src/main/serverContext';

function createServices(): ServerServices {
  return {
    bridgeClient: { listProjects: vi.fn() },
    bridgeConnection: { start: vi.fn(), dispose: vi.fn() },
    bridgeLauncher: { ensureRunning: vi.fn(), stop: vi.fn() },
    teamProvisioning: { listTeams: vi.fn(), appendMessage: vi.fn() },
    systemManagerConfig: { read: vi.fn() },
    workflowPrompt: { read: vi.fn() },
    conversationTelemetry: { listConversations: vi.fn() },
    localSessionScanner: { scanAll: vi.fn() },
    loopAssetsScanner: { scan: vi.fn() },
    directCli: { on: vi.fn(), shutdown: vi.fn() },
    imLiveWatcher: { start: vi.fn(), stop: vi.fn() },
    ccSettings: { read: vi.fn() },
    update: { checkForUpdates: vi.fn() },
  } as unknown as ServerServices;
}

describe('server context', () => {
  it('creates isolated runtime state for each context', () => {
    const first = createServerRuntimeState();
    const second = createServerRuntimeState();

    first.directCliRoutes.set('session-1', {
      teamName: 'team-a',
      from: 'team-a',
      to: 'user',
    });
    first.bridgeSessionTeamCache.set('bridge-1', {
      teamName: 'team-a',
      expiresAt: 123,
    });
    first.scheduleRunsById.set('schedule-1', []);
    first.teamStatsCache.set('/code/agentcli', {
      expiresAt: 123,
      value: null,
    });

    expect(second.directCliRoutes.size).toBe(0);
    expect(second.bridgeSessionTeamCache.size).toBe(0);
    expect(second.scheduleRunsById.size).toBe(0);
    expect(second.teamStatsCache.size).toBe(0);
    expect(first.sseClients).not.toBe(second.sseClients);
    expect(first.permissionSessionByRequestId).not.toBe(second.permissionSessionByRequestId);
  });

  it('assembles existing singleton services without starting resources', () => {
    const services = createServices();
    const context = createServerContext({ services });

    expect(context.services).toBe(services);
    expect(context.lifecycle.listenerDisposers).toEqual([]);
    expect(context.lifecycle.startPromise).toBeNull();
    expect(context.lifecycle.disposePromise).toBeNull();
    expect(services.bridgeConnection.start).not.toHaveBeenCalled();
    expect(services.imLiveWatcher.start).not.toHaveBeenCalled();
  });

  it('uses the caller-provided state by reference', () => {
    const services = createServices();
    const state = createServerRuntimeState();
    const context = createServerContext({ services, state });

    expect(context.state).toBe(state);
  });
});

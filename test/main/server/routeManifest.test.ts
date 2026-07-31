import { describe, expect, it } from 'vitest';

import {
  collectRouteRegistrations,
  OPERATIONS_SOURCE,
  routeKey,
  type RouteRegistration,
  ROUTE_METHODS,
  ROUTE_MODULES,
  SERVER_SOURCE,
  STANDALONE_SOURCE,
  STARTUP_SOURCE,
  WORKBENCH_SOURCE,
} from './routeManifestBaseline';

describe('server route manifest baseline', () => {
  const routes = collectRouteRegistrations();

  it('locks the pre-extraction route and method totals', () => {
    const methodCounts = Object.fromEntries(
      [...ROUTE_METHODS].map((method) => [
        method.toUpperCase(),
        routes.filter((route) => route.method === method.toUpperCase()).length,
      ])
    );

    expect(routes).toHaveLength(269);
    expect(methodCounts).toEqual({
      GET: 108,
      POST: 126,
      PUT: 6,
      PATCH: 14,
      DELETE: 12,
      ALL: 3,
    });
  });

  it('does not count orphaned route modules as active registrations', () => {
    const orphanedRegistrars = ROUTE_MODULES.filter(
      (module) => module.registrar && !WORKBENCH_SOURCE.includes(`${module.registrar}(`)
    ).map((module) => module.registrar);
    expect(orphanedRegistrars).toEqual([]);
  });

  it('does not register duplicate method/path pairs', () => {
    const keys = routes.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pins critical wildcard, static, SSE and compatibility routes', () => {
    const keys = new Set(routes.map(routeKey));

    expect(keys).toEqual(
      expect.objectContaining({
        size: 269,
      })
    );
    expect(keys.has('ALL /api/v1/*')).toBe(true);
    expect(keys.has('GET /api/v1/system/readiness')).toBe(true);
    expect(keys.has('GET /api/teams/runtime/alive')).toBe(true);
    expect(keys.has('GET /api/teams/tasks')).toBe(true);
    expect(keys.has('GET /api/task-bus/tasks')).toBe(true);
    expect(keys.has('POST /api/task-bus/tasks/:id/complete')).toBe(true);
    expect(keys.has('POST /api/teams/:name/tasks/:id/attachments')).toBe(true);
    expect(keys.has('GET /api/teams/:name/tasks/:id/attachments/:attachmentId')).toBe(true);
    expect(keys.has('DELETE /api/teams/:name/tasks/:id/attachments/:attachmentId')).toBe(true);
    expect(keys.has('GET /api/teams/templates')).toBe(true);
    expect(keys.has('POST /api/teams/tool-approval/read-file')).toBe(true);
    expect(keys.has('GET /api/telemetry/conversations/export')).toBe(true);
    expect(keys.has('GET /api/telemetry/conversations/:sessionId')).toBe(true);
    expect(keys.has('GET /api/events')).toBe(true);
    expect(keys.has('GET /api/extensions/skills/:skillId')).toBe(true);
    expect(keys.has('POST /api/advanced-connections/:connectionId/token-pool/claim-apply')).toBe(
      true
    );
    expect(keys.has('POST /api/collaboration/runs/:runId/request-changes')).toBe(true);
  });

  it('constructs Fastify before event wiring and keeps process startup explicit', () => {
    const appConstruction = WORKBENCH_SOURCE.indexOf(
      'const app = (options.appFactory ?? Fastify)('
    );
    const operationsCreation = WORKBENCH_SOURCE.indexOf('createServerOperations({');
    const factoryCreation = STANDALONE_SOURCE.indexOf('await createWorkbenchServer(');
    const standaloneStartup = STANDALONE_SOURCE.indexOf('startPromise ??= startRuntime({');

    expect(appConstruction).toBeGreaterThanOrEqual(0);
    expect(appConstruction).toBeLessThan(operationsCreation);
    expect(factoryCreation).toBeGreaterThanOrEqual(0);
    expect(factoryCreation).toBeLessThan(standaloneStartup);
    expect(SERVER_SOURCE).toContain('if (isDirectServerExecution(import.meta.url))');
  });

  it('keeps bridge startup behind event wiring with one on-demand retry call', () => {
    const eventHandlerRegistration = OPERATIONS_SOURCE.indexOf('registerServerEventHandlers({');
    const onDemandStarts = OPERATIONS_SOURCE.split('\n').filter(
      (line) => line.trim() === 'bridge.start();'
    );
    const standaloneStarts = STARTUP_SOURCE.split('\n').filter(
      (line) => line.trim() === 'bridge.start();'
    );

    expect(eventHandlerRegistration).toBeGreaterThanOrEqual(0);
    expect(onDemandStarts).toHaveLength(1);
    expect(standaloneStarts).toHaveLength(1);
  });

  it('preserves the team session and compatibility registrar sequence', () => {
    const registrars = [
      "registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['read'] })",
      'registerTeamSessionRoutes(app',
      "registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['process'] })",
      'registerTeamCompatibilityRoutes(app',
      "registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['compatibility'] })",
      "registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['actions'] })",
      'registerTeamMemberCompatibilityRoutes(app',
      'registerTeamProvisioningCompatibilityRoutes(app',
      "registerTeamMessageRoutes(app, teamMessageRouteDependencies, { routes: ['send'] })",
      "registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['review-aliases'] })",
      "registerTeamActionCompatibilityRoutes(app, { routes: ['member-skip'] })",
      "registerTeamTaskRoutes(app, teamTaskRouteDependencies, { routes: ['late-aliases'] })",
      "registerTeamActionCompatibilityRoutes(app, { routes: ['remaining'] })",
      'registerTeamMemberStatsRoutes(app',
      'registerToolApprovalRoutes(app',
    ];
    const positions = registrars.map((registrar) => WORKBENCH_SOURCE.indexOf(registrar));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('records inline and composition ordering that extraction must preserve semantically', () => {
    const routeOf = (method: string, path: string): RouteRegistration => {
      const route = routes.find((candidate) => routeKey(candidate) === `${method} ${path}`);
      expect(route, `${method} ${path} must exist`).toBeDefined();
      return route!;
    };
    const expectSameFileOrder = (
      leftMethod: string,
      leftPath: string,
      rightMethod: string,
      rightPath: string
    ) => {
      const left = routeOf(leftMethod, leftPath);
      const right = routeOf(rightMethod, rightPath);
      expect(left.file).toBe(right.file);
      expect(left.line).toBeLessThan(right.line);
    };

    expect(WORKBENCH_SOURCE.indexOf('registerBridgeProxyRoutes(app')).toBeLessThan(
      WORKBENCH_SOURCE.indexOf('registerRuntimeRoutes(app')
    );
    expectSameFileOrder(
      'GET',
      '/api/telemetry/conversations/export',
      'GET',
      '/api/telemetry/conversations/:sessionId'
    );
    expect(WORKBENCH_SOURCE.indexOf('registerUsageTelemetryRoutes(app')).toBeLessThan(
      WORKBENCH_SOURCE.indexOf('registerConversationTelemetryRoutes(app')
    );
    expect(WORKBENCH_SOURCE.indexOf('registerConversationTelemetryRoutes(app')).toBeLessThan(
      WORKBENCH_SOURCE.indexOf('registerUsageTelemetryStatusRoutes(app')
    );
    expect(WORKBENCH_SOURCE.indexOf('registerSseRoutes(app')).toBeLessThan(
      WORKBENCH_SOURCE.indexOf('registerExtensionPluginRoutes(app')
    );
  });
});

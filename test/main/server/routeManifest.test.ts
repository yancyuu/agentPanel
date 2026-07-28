/* eslint-disable security/detect-non-literal-fs-filename -- test scans repository-controlled paths */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_PATH = resolve(process.cwd(), 'src/main/server.ts');
const WORKBENCH_PATH = resolve(process.cwd(), 'src/main/workbenchServer.ts');
const OPERATIONS_PATH = resolve(process.cwd(), 'src/main/serverOperations.ts');
const STANDALONE_PATH = resolve(process.cwd(), 'src/main/serverStandalone.ts');
const ROUTES_DIR = resolve(process.cwd(), 'src/main/routes');
const STARTUP_PATH = resolve(process.cwd(), 'src/main/serverStartup.ts');
const SERVER_SOURCE = readFileSync(SERVER_PATH, 'utf8');
const WORKBENCH_SOURCE = readFileSync(WORKBENCH_PATH, 'utf8');
const OPERATIONS_SOURCE = readFileSync(OPERATIONS_PATH, 'utf8');
const STANDALONE_SOURCE = readFileSync(STANDALONE_PATH, 'utf8');
const STARTUP_SOURCE = readFileSync(STARTUP_PATH, 'utf8');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

const ROUTE_MODULES = collectTypeScriptFiles(ROUTES_DIR).map((sourcePath) => {
  const sourceText = readFileSync(sourcePath, 'utf8');
  const registrar = /export (?:async )?function (register[A-Za-z0-9]+Routes)\s*\(/.exec(
    sourceText
  )?.[1];
  return { sourcePath, sourceText, registrar };
});
const ACTIVE_ROUTE_MODULES = ROUTE_MODULES.filter(
  (module) => module.registrar && WORKBENCH_SOURCE.includes(`${module.registrar}(`)
);
const ROUTE_SOURCE_PATHS = [
  WORKBENCH_PATH,
  ...ACTIVE_ROUTE_MODULES.map((module) => module.sourcePath),
];

interface RouteRegistration {
  file: string;
  method: string;
  path: string;
  line: number;
}

function collectRouteRegistrations(): RouteRegistration[] {
  return ROUTE_SOURCE_PATHS.flatMap((sourcePath) => {
    const sourceText = readFileSync(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      sourcePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const routes: RouteRegistration[] = [];

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const method = node.expression.name.text;
        const routePath = node.arguments[0];

        if (
          ts.isIdentifier(receiver) &&
          receiver.text === 'app' &&
          ROUTE_METHODS.has(method) &&
          routePath &&
          (ts.isStringLiteral(routePath) || ts.isNoSubstitutionTemplateLiteral(routePath))
        ) {
          routes.push({
            file: sourcePath,
            method: method.toUpperCase(),
            path: routePath.text,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return routes;
  });
}

function routeKey(route: Pick<RouteRegistration, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

describe('server route manifest baseline', () => {
  const routes = collectRouteRegistrations();

  it('locks the pre-extraction route and method totals', () => {
    const methodCounts = Object.fromEntries(
      [...ROUTE_METHODS].map((method) => [
        method.toUpperCase(),
        routes.filter((route) => route.method === method.toUpperCase()).length,
      ])
    );

    expect(routes).toHaveLength(235);
    expect(methodCounts).toEqual({
      GET: 97,
      POST: 108,
      PUT: 5,
      PATCH: 13,
      DELETE: 9,
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
        size: 235,
      })
    );
    expect(keys.has('ALL /api/v1/*')).toBe(true);
    expect(keys.has('GET /api/v1/system/readiness')).toBe(true);
    expect(keys.has('GET /api/teams/runtime/alive')).toBe(true);
    expect(keys.has('GET /api/teams/tasks')).toBe(true);
    expect(keys.has('GET /api/teams/templates')).toBe(true);
    expect(keys.has('POST /api/teams/tool-approval/read-file')).toBe(true);
    expect(keys.has('GET /api/telemetry/conversations/export')).toBe(true);
    expect(keys.has('GET /api/telemetry/conversations/:sessionId')).toBe(true);
    expect(keys.has('GET /api/events')).toBe(true);
    expect(keys.has('GET /api/extensions/skills/:skillId')).toBe(true);
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

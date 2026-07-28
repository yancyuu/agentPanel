import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_PATH = resolve(process.cwd(), 'src/main/server.ts');
const ROUTES_DIR = resolve(process.cwd(), 'src/main/routes');
const STARTUP_PATH = resolve(process.cwd(), 'src/main/serverStartup.ts');
const SERVER_SOURCE = readFileSync(SERVER_PATH, 'utf8');
const STARTUP_SOURCE = readFileSync(STARTUP_PATH, 'utf8');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

const ROUTE_SOURCE_PATHS = [SERVER_PATH, ...collectTypeScriptFiles(ROUTES_DIR)];

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

  it('constructs Fastify before import-time bridge and listener wiring', () => {
    const appConstruction = SERVER_SOURCE.indexOf('const app = Fastify(');
    const eagerBridgeStart = SERVER_SOURCE.indexOf('bridge.start();');
    const eventHandlerRegistration = SERVER_SOURCE.indexOf('registerServerEventHandlers({');

    expect(appConstruction).toBeGreaterThanOrEqual(0);
    expect(appConstruction).toBeLessThan(eagerBridgeStart);
    expect(appConstruction).toBeLessThan(eventHandlerRegistration);
  });

  it('pins bridge startup and on-demand retry behavior until ownership is explicit', () => {
    const serverStarts = SERVER_SOURCE.match(/^\s*bridge\.start\(\);$/gm) ?? [];
    const standaloneStarts = STARTUP_SOURCE.match(/^\s*bridge\.start\(\);$/gm) ?? [];
    expect(serverStarts).toHaveLength(2);
    expect(standaloneStarts).toHaveLength(1);
  });

  it('records the current source ordering that extraction must preserve semantically', () => {
    const lineOf = (method: string, path: string): number => {
      const route = routes.find((candidate) => routeKey(candidate) === `${method} ${path}`);
      expect(route, `${method} ${path} must exist`).toBeDefined();
      return route?.line ?? -1;
    };

    expect(lineOf('ALL', '/api/v1/*')).toBeLessThan(lineOf('GET', '/api/v1/system/readiness'));
    expect(lineOf('GET', '/api/telemetry/conversations/export')).toBeLessThan(
      lineOf('GET', '/api/telemetry/conversations/:sessionId')
    );
    expect(lineOf('GET', '/api/events')).toBeLessThan(lineOf('GET', '/api/extensions/plugins'));
  });
});

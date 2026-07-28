import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SERVER_PATH = resolve(process.cwd(), 'src/main/server.ts');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

interface RouteRegistration {
  method: string;
  path: string;
  line: number;
}

function collectRouteRegistrations(): RouteRegistration[] {
  const sourceText = readFileSync(SERVER_PATH, 'utf8');
  const sourceFile = ts.createSourceFile(
    SERVER_PATH,
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
          method: method.toUpperCase(),
          path: routePath.text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes.sort((left, right) => left.line - right.line);
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

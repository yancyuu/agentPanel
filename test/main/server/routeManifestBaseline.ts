/* eslint-disable security/detect-non-literal-fs-filename -- test scans repository-controlled paths */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

export const SERVER_PATH = resolve(process.cwd(), 'src/main/server.ts');
export const WORKBENCH_PATH = resolve(process.cwd(), 'src/main/workbenchServer.ts');
export const OPERATIONS_PATH = resolve(process.cwd(), 'src/main/serverOperations.ts');
export const STANDALONE_PATH = resolve(process.cwd(), 'src/main/serverStandalone.ts');
export const ROUTES_DIR = resolve(process.cwd(), 'src/main/routes');
export const STARTUP_PATH = resolve(process.cwd(), 'src/main/serverStartup.ts');
export const COLLABORATION_ROUTES_PATH = resolve(
  process.cwd(),
  'src/features/team-collaboration/main/registerCollaborationRoutes.ts'
);
export const ADVANCED_CONNECTION_ROUTES_PATH = resolve(
  process.cwd(),
  'src/features/advanced-connections/main/adapters/input/registerAdvancedConnectionRoutes.ts'
);
export const SERVER_SOURCE = readFileSync(SERVER_PATH, 'utf8');
export const WORKBENCH_SOURCE = readFileSync(WORKBENCH_PATH, 'utf8');
export const OPERATIONS_SOURCE = readFileSync(OPERATIONS_PATH, 'utf8');
export const STANDALONE_SOURCE = readFileSync(STANDALONE_PATH, 'utf8');
export const STARTUP_SOURCE = readFileSync(STARTUP_PATH, 'utf8');
export const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

export const ROUTE_MODULES = collectTypeScriptFiles(ROUTES_DIR).map((sourcePath) => {
  const sourceText = readFileSync(sourcePath, 'utf8');
  const registrar = /export (?:async )?function (register[A-Za-z0-9]+Routes)\s*\(/.exec(
    sourceText
  )?.[1];
  return { sourcePath, sourceText, registrar };
});

export const ACTIVE_ROUTE_MODULES = ROUTE_MODULES.filter(
  (module) => module.registrar && WORKBENCH_SOURCE.includes(`${module.registrar}(`)
);

const ROUTE_SOURCE_PATHS = [
  WORKBENCH_PATH,
  COLLABORATION_ROUTES_PATH,
  ADVANCED_CONNECTION_ROUTES_PATH,
  ...ACTIVE_ROUTE_MODULES.map((module) => module.sourcePath),
];

export interface RouteRegistration {
  file: string;
  method: string;
  path: string;
  line: number;
}

export function collectRouteRegistrations(): RouteRegistration[] {
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

export function routeKey(route: Pick<RouteRegistration, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

export function sortedRouteKeys(routes = collectRouteRegistrations()): string[] {
  return routes.map(routeKey).sort((left, right) => left.localeCompare(right));
}

export function methodCounts(routeKeys: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of routeKeys) {
    const method = key.slice(0, key.indexOf(' '));
    counts[method] = (counts[method] ?? 0) + 1;
  }
  return counts;
}

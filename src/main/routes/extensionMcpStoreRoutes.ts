import type { extensionHandlers } from '../ipc/extensions';
import type {
  McpCustomInstallRequest,
  McpLibraryImportRequest,
  McpLibraryUpsertRequest,
} from '@shared/types/extensions';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';
import type { FastifyInstance } from 'fastify';

type ExtensionHandlers = typeof extensionHandlers;

type McpStoreRouteHandlers = Pick<
  ExtensionHandlers,
  | 'mcpGetInstalled'
  | 'mcpInstallCustom'
  | 'mcpUninstall'
  | 'mcpLibraryList'
  | 'mcpLibraryUpsert'
  | 'mcpLibraryDelete'
  | 'mcpLibraryImport'
>;

interface ExtensionMcpStoreRouteDependencies {
  handlers: McpStoreRouteHandlers;
}

export function registerExtensionMcpStoreRoutes(
  app: FastifyInstance,
  { handlers }: ExtensionMcpStoreRouteDependencies
): void {
  app.get('/api/extensions/mcp/installed', async (request) => {
    const projectPath = (request.query as Record<string, string>).projectPath;
    return handlers.mcpGetInstalled(projectPath);
  });

  app.post('/api/extensions/mcp/install-custom', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.mcpInstallCustom(body as unknown as McpCustomInstallRequest);
  });

  app.post('/api/extensions/mcp/uninstall', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.mcpUninstall(
      body.name as string,
      body.scope as string,
      body.projectPath as string,
      body.harnessType as HermitBridgeAgentType | undefined
    );
  });

  app.get('/api/extensions/mcp/library', async () => handlers.mcpLibraryList());

  app.post('/api/extensions/mcp/library', async (request) =>
    handlers.mcpLibraryUpsert(request.body as McpLibraryUpsertRequest)
  );

  app.delete('/api/extensions/mcp/library/:id', async (request) => {
    const { id } = request.params as { id: string };
    return handlers.mcpLibraryDelete(id);
  });

  app.post('/api/extensions/mcp/library/import', async (request) =>
    handlers.mcpLibraryImport((request.body ?? {}) as McpLibraryImportRequest)
  );
}

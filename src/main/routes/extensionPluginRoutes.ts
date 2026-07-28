import type { extensionHandlers } from '../ipc/extensions';
import type { PluginInstallRequest } from '@shared/types/extensions';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';
import type { FastifyInstance } from 'fastify';

type ExtensionHandlers = typeof extensionHandlers;

type PluginRouteHandlers = Pick<
  ExtensionHandlers,
  'pluginGetAll' | 'pluginGetReadme' | 'pluginInstall' | 'pluginUninstall'
>;

interface ExtensionPluginRouteDependencies {
  handlers: PluginRouteHandlers;
}

export function registerExtensionPluginRoutes(
  app: FastifyInstance,
  { handlers }: ExtensionPluginRouteDependencies
): void {
  app.get('/api/extensions/plugins', async () => handlers.pluginGetAll());

  app.get('/api/extensions/plugins/readme/:pluginId', async (request) => {
    const { pluginId } = request.params as { pluginId: string };
    return handlers.pluginGetReadme(pluginId);
  });

  app.post('/api/extensions/plugins/install', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.pluginInstall(body as unknown as PluginInstallRequest);
  });

  app.post('/api/extensions/plugins/uninstall', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.pluginUninstall(
      body.pluginId as string,
      body.scope as string,
      body.projectPath as string,
      body.harnessType as HermitBridgeAgentType | undefined
    );
  });
}

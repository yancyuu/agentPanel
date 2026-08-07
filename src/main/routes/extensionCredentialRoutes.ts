import type { extensionHandlers } from '../ipc/extensions';
import type { FastifyInstance } from 'fastify';

type ExtensionHandlers = typeof extensionHandlers;

type CredentialRouteHandlers = Pick<
  ExtensionHandlers,
  | 'credentialsStatus'
  | 'credentialsGetMcp'
  | 'credentialsSaveMcp'
  | 'credentialsGetProjectEnv'
  | 'credentialsSaveProjectEnv'
  | 'credentialsScanRequired'
  | 'credentialsResolveAgentEnv'
  | 'credentialsGetSkillGlobalEnv'
  | 'credentialsSaveSkillGlobalEnv'
>;

interface ExtensionCredentialRouteDependencies {
  handlers: CredentialRouteHandlers;
}

export function registerExtensionCredentialRoutes(
  app: FastifyInstance,
  { handlers }: ExtensionCredentialRouteDependencies
): void {
  app.get('/api/extensions/credentials/status', async () => handlers.credentialsStatus());

  app.get('/api/extensions/credentials/mcp/:mcpName', async (request) => {
    const { mcpName } = request.params as { mcpName: string };
    return handlers.credentialsGetMcp(mcpName);
  });

  app.post('/api/extensions/credentials/mcp', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.credentialsSaveMcp(
      body.mcpName as string,
      body.envValues as Record<string, string>
    );
  });

  app.get('/api/extensions/credentials/project-env', async (request) => {
    const projectPath = (request.query as Record<string, string>).projectPath;
    if (!projectPath) return { error: 'projectPath required' };
    return handlers.credentialsGetProjectEnv(projectPath);
  });

  app.post('/api/extensions/credentials/project-env', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.credentialsSaveProjectEnv(
      body.projectPath as string,
      body.vars as Record<string, string>
    );
  });

  app.post('/api/extensions/credentials/scan-required', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.credentialsScanRequired(
      body.projectPath as string,
      body.mcpServers as {
        name: string;
        envVars?: { name: string; isRequired: boolean; description?: string }[];
      }[],
      body.skillReqs as {
        name: string;
        envVars: { name: string; isRequired?: boolean; description?: string }[];
      }[]
    );
  });

  app.get('/api/extensions/credentials/resolve-agent-env', async (request) => {
    const projectPath = (request.query as Record<string, string>).projectPath;
    if (!projectPath) return { error: 'projectPath required' };
    return handlers.credentialsResolveAgentEnv(projectPath);
  });

  app.get('/api/extensions/credentials/skill-env', async (request) => {
    const folderName = (request.query as Record<string, string>).folderName;
    if (!folderName) return { error: 'folderName required' };
    return handlers.credentialsGetSkillGlobalEnv(folderName);
  });

  app.post('/api/extensions/credentials/skill-env', async (request) => {
    const body = request.body as Record<string, unknown>;
    return handlers.credentialsSaveSkillGlobalEnv(
      body.folderName as string,
      body.vars as Record<string, string>
    );
  });
}

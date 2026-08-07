import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerExtensionCredentialRoutes } from '../../../src/main/routes/extensionCredentialRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerExtensionCredentialRoutes>[1];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const result = () => Promise.resolve({ success: true, data: { ok: true } });
  const handlers = {
    credentialsStatus: vi.fn(result),
    credentialsGetMcp: vi.fn(result),
    credentialsSaveMcp: vi.fn(result),
    credentialsGetProjectEnv: vi.fn(result),
    credentialsSaveProjectEnv: vi.fn(result),
    credentialsScanRequired: vi.fn(result),
    credentialsResolveAgentEnv: vi.fn(result),
    credentialsGetSkillGlobalEnv: vi.fn(result),
    credentialsSaveSkillGlobalEnv: vi.fn(result),
  } as unknown as Dependencies['handlers'];
  registerExtensionCredentialRoutes(app, { handlers });
  return { app, handlers };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('extension credential routes', () => {
  it('preserves required-query error payloads without invoking handlers', async () => {
    const { app, handlers } = createHarness();

    const project = await app.inject({
      method: 'GET',
      url: '/api/extensions/credentials/project-env',
    });
    const agent = await app.inject({
      method: 'GET',
      url: '/api/extensions/credentials/resolve-agent-env',
    });
    const skill = await app.inject({
      method: 'GET',
      url: '/api/extensions/credentials/skill-env',
    });

    expect(project.json()).toEqual({ error: 'projectPath required' });
    expect(agent.json()).toEqual({ error: 'projectPath required' });
    expect(skill.json()).toEqual({ error: 'folderName required' });
    expect(handlers.credentialsGetProjectEnv).not.toHaveBeenCalled();
    expect(handlers.credentialsResolveAgentEnv).not.toHaveBeenCalled();
    expect(handlers.credentialsGetSkillGlobalEnv).not.toHaveBeenCalled();
  });

  it('forwards MCP, project, skill, status, and scan inputs unchanged', async () => {
    const { app, handlers } = createHarness();
    const mcpServers = [{ name: 'mcp-a', envVars: [{ name: 'TOKEN', isRequired: true }] }];
    const skillReqs = [{ name: 'skill-a', envVars: [{ name: 'KEY' }] }];

    await app.inject({ method: 'GET', url: '/api/extensions/credentials/status' });
    await app.inject({ method: 'GET', url: '/api/extensions/credentials/mcp/mcp-a' });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/credentials/mcp',
      payload: { mcpName: 'mcp-a', envValues: { TOKEN: 'secret' } },
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/credentials/project-env',
      payload: { projectPath: '/tmp/project', vars: { KEY: 'value' } },
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/credentials/scan-required',
      payload: { projectPath: '/tmp/project', mcpServers, skillReqs },
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/credentials/skill-env',
      payload: { folderName: 'skill-a', vars: { KEY: 'value' } },
    });

    expect(handlers.credentialsStatus).toHaveBeenCalledOnce();
    expect(handlers.credentialsGetMcp).toHaveBeenCalledWith('mcp-a');
    expect(handlers.credentialsSaveMcp).toHaveBeenCalledWith('mcp-a', { TOKEN: 'secret' });
    expect(handlers.credentialsSaveProjectEnv).toHaveBeenCalledWith('/tmp/project', {
      KEY: 'value',
    });
    expect(handlers.credentialsScanRequired).toHaveBeenCalledWith(
      '/tmp/project',
      mcpServers,
      skillReqs
    );
    expect(handlers.credentialsSaveSkillGlobalEnv).toHaveBeenCalledWith('skill-a', {
      KEY: 'value',
    });
  });
});

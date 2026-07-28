import type { FastifyInstance } from 'fastify';

interface HarnessProject {
  agent_type?: string;
}

interface HarnessRouteDependencies {
  agentTypes: readonly string[];
  listProjects(): Promise<HarnessProject[]>;
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  { agentTypes, listProjects }: HarnessRouteDependencies
): void {
  app.get('/api/harnesses', async () => {
    try {
      const projects = await listProjects();
      const usedTypes = new Set(projects.map((project) => project.agent_type));
      return agentTypes.map((type) => ({ type, inUse: usedTypes.has(type) }));
    } catch {
      return agentTypes.map((type) => ({ type, inUse: false }));
    }
  });
}

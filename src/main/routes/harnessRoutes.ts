import { execFile } from 'node:child_process';

import type { FastifyInstance } from 'fastify';

interface HarnessProject {
  agent_type?: string;
}

interface HarnessRouteDependencies {
  agentTypes: readonly string[];
  listProjects(): Promise<HarnessProject[]>;
  packagedDesktop?: boolean;
  isCommandAvailable?: (this: void, command: string) => Promise<boolean>;
}

const COMMAND_BY_AGENT_TYPE: Readonly<Record<string, string>> = {
  claudecode: 'claude',
  codex: 'codex',
  pi: 'pi',
};

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 5_000, windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  {
    agentTypes,
    listProjects,
    packagedDesktop = false,
    isCommandAvailable = commandAvailable,
  }: HarnessRouteDependencies
): void {
  app.get('/api/harnesses', async () => {
    let projects: HarnessProject[] = [];
    try {
      projects = await listProjects();
    } catch {
      projects = [];
    }
    const usedTypes = new Set(projects.map((project) => project.agent_type));
    if (!packagedDesktop) {
      return agentTypes.map((type) => ({ type, inUse: usedTypes.has(type) }));
    }
    const availability = new Map<string, boolean>();
    await Promise.all(
      Object.entries(COMMAND_BY_AGENT_TYPE).map(async ([type, command]) => {
        availability.set(type, await isCommandAvailable(command));
      })
    );
    return agentTypes.map((type) => ({
      type,
      inUse: usedTypes.has(type),
      available: availability.get(type) ?? false,
      bundled: type === 'pi',
      desktopManaged: true,
    }));
  });
}

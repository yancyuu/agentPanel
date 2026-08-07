import type { FastifyInstance } from 'fastify';

interface GraphProject {
  name: string;
  agent_type?: string;
}

interface GraphTask {
  id: string;
  title: string;
  assignee?: string | null;
  status: string;
}

interface GraphRouteDependencies {
  listProjects(): Promise<GraphProject[]>;
  readTasks(teamName: string): Promise<GraphTask[]>;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerGraphRoutes(
  app: FastifyInstance,
  { listProjects, readTasks }: GraphRouteDependencies
): void {
  app.get('/api/graph', async () => {
    try {
      const projects = await listProjects();
      const nodes = projects.map((project) => ({
        id: project.name,
        label: project.name,
        harness: project.agent_type,
        color: 'blue',
        collaboration: true,
        bindProject: project.name,
      }));
      const edges: { source: string; target: string; taskId: string; taskTitle: string }[] = [];
      for (const project of projects) {
        try {
          const tasks = await readTasks(project.name);
          for (const task of tasks) {
            if (task.assignee && task.status !== 'done') {
              edges.push({
                source: project.name,
                target: task.assignee,
                taskId: task.id,
                taskTitle: task.title,
              });
            }
          }
        } catch {
          // One unreadable team must not hide the rest of the graph.
        }
      }
      return { ok: true, data: { nodes, edges } };
    } catch (error) {
      return errorPayload(error);
    }
  });
}

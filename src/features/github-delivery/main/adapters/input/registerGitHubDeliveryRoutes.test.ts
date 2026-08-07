import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGitHubDeliveryRoutes } from './registerGitHubDeliveryRoutes';

const applications: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe('registerGitHubDeliveryRoutes', () => {
  it('binds a repository and publishes only explicit task identity', async () => {
    const service = {
      listBindings: vi.fn().mockResolvedValue([]),
      saveBinding: vi.fn().mockResolvedValue({
        agentName: 'writer',
        repository: 'example/results',
        branch: 'agentpanel-deliveries',
      }),
      deleteBinding: vi.fn().mockResolvedValue(undefined),
      resolveArchivedVersion: vi.fn().mockResolvedValue({
        outputDir: '/safe/output',
        versionDir: '/safe/output/versions/v1',
        title: 'Result',
        versionId: 'v1',
      }),
      publish: vi.fn().mockResolvedValue({
        repository: 'example/results',
        branch: 'agentpanel-deliveries',
        path: 'deliveries/demo/task-1/v1',
        commit: 'abc123',
        url: 'https://github.com/example/results',
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const app = Fastify();
    applications.push(app);
    registerGitHubDeliveryRoutes(app, { service });

    const binding = await app.inject({
      method: 'PUT',
      url: '/api/github-delivery/bindings/writer',
      payload: { repository: 'example/results' },
    });
    const unbind = await app.inject({
      method: 'DELETE',
      url: '/api/github-delivery/bindings/writer',
    });
    const archive = await app.inject({
      method: 'GET',
      url: '/api/github-delivery/archive/demo/task-1',
    });
    const publish = await app.inject({
      method: 'POST',
      url: '/api/github-delivery/publish',
      payload: { teamName: 'demo', taskId: 'task-1', agentName: 'writer' },
    });

    expect(binding.statusCode).toBe(200);
    expect(service.saveBinding).toHaveBeenCalledWith('writer', { repository: 'example/results' });
    expect(unbind.statusCode).toBe(204);
    expect(service.deleteBinding).toHaveBeenCalledWith('writer');
    expect(archive.statusCode).toBe(200);
    expect(archive.json()).toEqual({
      ok: true,
      data: {
        outputDir: '/safe/output',
        versionDir: '/safe/output/versions/v1',
        title: 'Result',
        versionId: 'v1',
      },
    });
    expect(publish.statusCode).toBe(200);
    expect(service.publish).toHaveBeenCalledWith({
      teamName: 'demo',
      taskId: 'task-1',
      agentName: 'writer',
    });
  });

  it('rejects a publish request missing a task identity', async () => {
    const app = Fastify();
    applications.push(app);
    registerGitHubDeliveryRoutes(app, {
      service: {
        listBindings: vi.fn(),
        saveBinding: vi.fn(),
        deleteBinding: vi.fn(),
        resolveArchivedVersion: vi.fn(),
        publish: vi.fn(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/github-delivery/publish',
      payload: { teamName: 'demo' },
    });
    expect(response.statusCode).toBe(400);
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CollaborationWorkspaceService,
  registerCollaborationRoutes,
} from '@features/team-collaboration/main';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { CollaborationRun } from '@features/team-collaboration/shared/contracts';
import type { TeamProvisioningService } from '@main/services/team-management';
import type { Task, TeamManifest } from '@main/services/team-management/TeamWorkspaceService';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('collaboration routes', () => {
  it('returns completed after the user approves the root task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-collaboration-route-'));
    temporaryDirectories.push(root);
    const workspace = new CollaborationWorkspaceService(root);
    const team = await workspace.createTeam({
      displayName: '审核同步小队',
      memberTeamSlugs: ['agent-a', 'agent-b'],
    });
    const now = new Date().toISOString();
    const run: CollaborationRun = {
      schemaVersion: 1,
      id: 'run-approved-route',
      collaborationTeamSlug: team.slug,
      collaborationTeamDisplayName: team.displayName,
      title: '已审核任务',
      phase: 'review',
      members: [],
      ballots: [],
      rootTaskId: 'root-task',
      rootTaskTeamSlug: 'agent-a',
      workItems: [],
      finalResult: '完成结果',
      createdAt: now,
      updatedAt: now,
    };
    await workspace.createRun(run);
    const manifest = (slug: string): TeamManifest => ({
      schemaVersion: 2,
      slug,
      displayName: slug,
      bindProject: slug,
      harness: 'claudecode',
      workDir: root,
      collaboration: true,
      rootPath: root,
      createdAt: now,
    });
    const rootTask: Task = {
      id: 'root-task',
      teamSlug: 'agent-a',
      title: run.title,
      description: '',
      status: 'done',
      reviewState: 'approved',
      assignee: null,
      result: run.finalResult ?? null,
      createdAt: now,
      updatedAt: now,
      order: 0,
    };
    const teams = {
      readTeamManifest: (slug: string) => Promise.resolve(manifest(slug)),
      readTasks: () => Promise.resolve([rootTask]),
    } as Pick<TeamProvisioningService, 'readTeamManifest' | 'readTasks'>;
    const app = Fastify();
    registerCollaborationRoutes(app, {
      workspace,
      teams,
      orchestrator: { createRun: () => Promise.reject(new Error('unused')), start: () => undefined } as never,
    });

    const response = await app.inject({ method: 'GET', url: `/api/collaboration/teams/${team.slug}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().runs[0]).toMatchObject({ id: run.id, phase: 'completed' });
    await expect(workspace.readRun(run.id)).resolves.toMatchObject({ phase: 'completed' });
    await app.close();
  });
});

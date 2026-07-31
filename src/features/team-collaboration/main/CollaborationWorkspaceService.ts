import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { toSlug } from '@main/services/team-management/TeamWorkspaceService';

import type {
  CollaborationRun,
  CollaborationTeam,
  CreateCollaborationTeamRequest,
} from '../shared/contracts';

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class CollaborationWorkspaceService {
  private readonly rootPath: string;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(hermitHome = process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit')) {
    this.rootPath = path.join(hermitHome, 'collaboration-teams');
  }

  private teamDirectory(teamSlug: string): string {
    return path.join(this.rootPath, teamSlug);
  }

  private teamFile(teamSlug: string): string {
    return path.join(this.teamDirectory(teamSlug), 'team.json');
  }

  private runFile(teamSlug: string, runId: string): string {
    return path.join(this.teamDirectory(teamSlug), 'runs', `${runId}.json`);
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const queue = current.then(
      () => undefined,
      () => undefined
    );
    this.mutations.set(key, queue);
    try {
      return await current;
    } finally {
      if (this.mutations.get(key) === queue) this.mutations.delete(key);
    }
  }

  async listTeams(): Promise<CollaborationTeam[]> {
    try {
      const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
      const teams = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readJson<CollaborationTeam | null>(this.teamFile(entry.name), null))
      );
      return teams
        .filter((team): team is CollaborationTeam => Boolean(team && !team.deletedAt))
        .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
    } catch {
      return [];
    }
  }

  async readTeam(teamSlug: string): Promise<CollaborationTeam> {
    const team = await readJson<CollaborationTeam | null>(this.teamFile(teamSlug), null);
    if (!team || team.deletedAt) throw new Error('协作团队不存在');
    return team;
  }

  async createTeam(request: CreateCollaborationTeamRequest): Promise<CollaborationTeam> {
    const displayName = request.displayName.trim();
    const memberTeamSlugs = [
      ...new Set(request.memberTeamSlugs.map((value) => value.trim())),
    ].filter(Boolean);
    if (!displayName) throw new Error('团队名称不能为空');
    if (memberTeamSlugs.length < 2) throw new Error('协作团队至少需要两名数字员工');

    const baseSlug = toSlug(displayName, 'collaboration-team');
    const existing = new Set((await this.listTeams()).map((team) => team.slug));
    let slug = baseSlug;
    let suffix = 2;
    while (existing.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    const now = new Date().toISOString();
    const team: CollaborationTeam = {
      schemaVersion: 1,
      slug,
      displayName,
      description: request.description?.trim() || undefined,
      memberTeamSlugs,
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(this.teamFile(slug), team);
    return team;
  }

  async deleteTeam(teamSlug: string): Promise<void> {
    await this.serialize(`team:${teamSlug}`, async () => {
      const team = await this.readTeam(teamSlug);
      await writeJson(this.teamFile(teamSlug), {
        ...team,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async listRuns(teamSlug: string): Promise<CollaborationRun[]> {
    const directory = path.join(this.teamDirectory(teamSlug), 'runs');
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch {
      return [];
    }
    const runs = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map((file) => readJson<CollaborationRun | null>(path.join(directory, file), null))
    );
    return runs
      .filter((run): run is CollaborationRun => Boolean(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async readRun(runId: string): Promise<CollaborationRun> {
    const teams = await this.listTeams();
    for (const team of teams) {
      const run = await readJson<CollaborationRun | null>(this.runFile(team.slug, runId), null);
      if (run) return run;
    }
    throw new Error('协作任务不存在');
  }

  async createRun(run: CollaborationRun): Promise<void> {
    await writeJson(this.runFile(run.collaborationTeamSlug, run.id), run);
  }

  async updateRun(
    runId: string,
    update: (current: CollaborationRun) => CollaborationRun
  ): Promise<CollaborationRun> {
    return this.serialize(`run:${runId}`, async () => {
      const current = await this.readRun(runId);
      const next = update(current);
      await writeJson(this.runFile(next.collaborationTeamSlug, runId), next);
      return next;
    });
  }
}

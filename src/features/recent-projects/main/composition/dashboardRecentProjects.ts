import { ListDashboardRecentProjectsUseCase } from '../../core/application/use-cases/ListDashboardRecentProjectsUseCase';
import {
  buildDefaultLocalClaudeProjectRoots,
  LocalClaudeProjectSource,
} from '../infrastructure/LocalClaudeProjectSource';

import type { DashboardRecentProjectsPayload } from '../../contracts';
import type { ListDashboardRecentProjectsResponse } from '../../core/application/models/ListDashboardRecentProjectsResponse';
import type { LoggerPort } from '../../core/application/ports/LoggerPort';
import type { RecentProjectsCachePort } from '../../core/application/ports/RecentProjectsCachePort';

const DASHBOARD_RECENT_PROJECTS_CACHE_KEY = 'dashboard:recent-projects';

class InMemoryRecentProjectsCache<T> implements RecentProjectsCachePort<T> {
  #entry: { key: string; value: T; expiresAt: number } | null = null;
  #stale: { key: string; value: T } | null = null;

  async get(key: string): Promise<T | null> {
    if (!this.#entry || this.#entry.key !== key) return null;
    if (Date.now() > this.#entry.expiresAt) return null;
    return this.#entry.value;
  }

  async getStale(key: string): Promise<T | null> {
    return this.#stale?.key === key ? this.#stale.value : null;
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    this.#entry = { key, value, expiresAt: Date.now() + ttlMs };
    this.#stale = { key, value };
  }
}

function presentDashboardRecentProjects(
  response: ListDashboardRecentProjectsResponse
): DashboardRecentProjectsPayload {
  return {
    degraded: response.degraded,
    projects: response.projects.map((project) => ({
      id: project.identity,
      name: project.displayName,
      primaryPath: project.primaryPath,
      associatedPaths: project.associatedPaths,
      mostRecentActivity: project.lastActivityAt,
      providerIds: project.providerIds,
      source: project.source,
      openTarget: project.openTarget,
      ...(project.branchName ? { primaryBranch: project.branchName } : {}),
    })),
  };
}

interface DashboardRecentProjectsLoaderOptions {
  extraRoots?: string[];
  logger: LoggerPort;
}

export function createDashboardRecentProjectsLoader({
  extraRoots = [],
  logger,
}: DashboardRecentProjectsLoaderOptions): () => Promise<DashboardRecentProjectsPayload> {
  const source = new LocalClaudeProjectSource({
    roots: buildDefaultLocalClaudeProjectRoots(extraRoots),
    includeClaudeSessionProjects: true,
  });
  const useCase = new ListDashboardRecentProjectsUseCase<DashboardRecentProjectsPayload>({
    sources: [source],
    cache: new InMemoryRecentProjectsCache<DashboardRecentProjectsPayload>(),
    output: { present: presentDashboardRecentProjects },
    clock: { now: () => Date.now() },
    logger,
  });

  return () => useCase.execute(DASHBOARD_RECENT_PROJECTS_CACHE_KEY);
}

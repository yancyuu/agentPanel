/**
 * Facade service that combines plugin catalog + installation state
 * into enriched data ready for the renderer.
 *
 * Also provides install target resolution for the security model
 * (main-side re-resolution: renderer sends pluginId, main resolves from catalog).
 */

import { createLogger } from '@shared/utils/logger';

import { type PluginCatalogService } from './catalog/PluginCatalogService';
import { type PluginInstallationStateService } from './state/PluginInstallationStateService';

import type { EnrichedPlugin, PluginCatalogItem } from '@shared/types/extensions';

const logger = createLogger('Extensions:Facade');

export class ExtensionFacadeService {
  constructor(
    private readonly pluginCatalog: PluginCatalogService,
    private readonly pluginState: PluginInstallationStateService
  ) {}

  // ── Plugin methods ───────────────────────────────────────────────────

  /**
   * Get all plugins enriched with install status and counts.
   */
  async getEnrichedPlugins(projectPath?: string, forceRefresh = false): Promise<EnrichedPlugin[]> {
    const [catalog, installed, counts] = await Promise.all([
      this.pluginCatalog.getPlugins(forceRefresh),
      this.pluginState.getInstalledPlugins(projectPath),
      this.pluginState.getInstallCounts(),
    ]);

    // Build installed lookup: pluginId → entries[]
    const installedMap = new Map<string, typeof installed>();
    for (const entry of installed) {
      const list = installedMap.get(entry.pluginId) ?? [];
      list.push(entry);
      installedMap.set(entry.pluginId, list);
    }

    return catalog.map((item): EnrichedPlugin => {
      const installations = installedMap.get(item.pluginId) ?? [];
      const installCount = counts.get(item.pluginId) ?? 0;

      return {
        ...item,
        installCount,
        isInstalled: installations.length > 0,
        installations,
      };
    });
  }

  /**
   * Get README content for a plugin.
   */
  async getPluginReadme(pluginId: string): Promise<string | null> {
    return this.pluginCatalog.getPluginReadme(pluginId);
  }

  /**
   * Resolve a pluginId to its install target.
   */
  async resolvePluginInstallTarget(
    pluginId: string
  ): Promise<{ qualifiedName: string; plugin: PluginCatalogItem } | null> {
    const plugin = await this.pluginCatalog.resolvePlugin(pluginId);
    if (!plugin) {
      logger.warn(`Cannot resolve install target: pluginId "${pluginId}" not found in catalog`);
      return null;
    }
    return { qualifiedName: plugin.qualifiedName, plugin };
  }

  // ── Cache invalidation ───────────────────────────────────────────────

  invalidateInstalledCache(): void {
    this.pluginState.invalidateCache();
  }
}

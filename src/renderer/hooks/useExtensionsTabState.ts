/**
 * Per-tab UI state hook for the Extension Store view.
 * Each Extensions tab instance gets its own independent state.
 * Global catalog caches are in extensionsSlice (Zustand).
 */

import { useCallback, useMemo, useState } from 'react';

import type { PluginCapability, PluginFilters, PluginSortField } from '@shared/types/extensions';

export type ExtensionsSubTab = 'plugins' | 'capability-packs';

interface PluginSortState {
  field: PluginSortField;
  order: 'asc' | 'desc';
}

const DEFAULT_FILTERS: PluginFilters = {
  search: '',
  categories: [],
  capabilities: [],
  installedOnly: false,
};

export function useExtensionsTabState() {
  // ── Sub-tab navigation ──
  const [activeSubTab, setActiveSubTab] = useState<ExtensionsSubTab>('plugins');

  // ── Plugin filters & sort ──
  const [pluginFilters, setPluginFilters] = useState<PluginFilters>(DEFAULT_FILTERS);
  const [pluginSort, setPluginSort] = useState<PluginSortState>({
    field: 'popularity',
    order: 'desc',
  });
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);

  // ── Plugin filter helpers ──
  const updatePluginSearch = useCallback((search: string) => {
    setPluginFilters((prev) => ({ ...prev, search }));
  }, []);

  const toggleCategory = useCallback((category: string) => {
    setPluginFilters((prev) => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter((c) => c !== category)
        : [...prev.categories, category],
    }));
  }, []);

  const toggleCapability = useCallback((capability: PluginCapability) => {
    setPluginFilters((prev) => ({
      ...prev,
      capabilities: prev.capabilities.includes(capability)
        ? prev.capabilities.filter((c) => c !== capability)
        : [...prev.capabilities, capability],
    }));
  }, []);

  const toggleInstalledOnly = useCallback(() => {
    setPluginFilters((prev) => ({ ...prev, installedOnly: !prev.installedOnly }));
  }, []);

  const clearFilters = useCallback(() => {
    setPluginFilters(DEFAULT_FILTERS);
  }, []);

  const hasActiveFilters = useMemo(
    () =>
      pluginFilters.search !== '' ||
      pluginFilters.categories.length > 0 ||
      pluginFilters.capabilities.length > 0 ||
      pluginFilters.installedOnly,
    [pluginFilters]
  );

  return {
    // Sub-tab
    activeSubTab,
    setActiveSubTab,

    // Plugins
    pluginFilters,
    pluginSort,
    setPluginSort,
    selectedPluginId,
    setSelectedPluginId,
    updatePluginSearch,
    toggleCategory,
    toggleCapability,
    toggleInstalledOnly,
    clearFilters,
    hasActiveFilters,
  };
}

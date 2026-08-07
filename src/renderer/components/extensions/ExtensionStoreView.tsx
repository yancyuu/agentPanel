/**
 * ExtensionStoreView — top-level component for the Extensions tab.
 * Uses per-tab UI state via useExtensionsTabState() hook.
 * Global catalog data comes from Zustand store.
 */

import { useCallback, useEffect, useMemo } from 'react';

// Stubs for removed codex-account feature
function useCodexAccountSnapshot(_opts: { enabled: boolean; includeRateLimits?: boolean }): {
  snapshot: null;
  loading: false;
} {
  return { snapshot: null, loading: false };
}
function mergeCodexProviderStatusWithSnapshot<T>(provider: T, _snapshot: unknown): T {
  return provider;
}

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { api } from '@renderer/api';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tabs, TabsContent, TabsList } from '@renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useTabIdOptional } from '@renderer/contexts/useTabUIContext';
import { useExtensionsTabState } from '@renderer/hooks/useExtensionsTabState';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import {
  filterExtensionStoreProviders,
  getVisibleMultimodelProviders,
  isMultimodelRuntimeStatus,
} from '@renderer/utils/multimodelProviderVisibility';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import { AlertTriangle, Boxes, Info, Loader2, Puzzle, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CapabilityPacksPanel } from './capability-packs/CapabilityPacksPanel';
import { StoreExtensionToast } from './common/ExtensionToast';
import { PluginsPanel } from './plugins/PluginsPanel';
import { ExtensionsSubTabTrigger } from './ExtensionsSubTabTrigger';

import type { ExtensionsSubTab } from '@renderer/hooks/useExtensionsTabState';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

const ProviderCapabilityCardSkeleton = ({
  providerId,
  displayName,
}: {
  providerId: CliProviderId;
  displayName: string;
}): React.JSX.Element => (
  <div className="rounded-md border border-border bg-surface-raised px-3 py-2">
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="inline-flex items-center gap-2 text-sm font-medium text-text">
          <ProviderBrandLogo providerId={providerId} className="size-4 shrink-0" />
          <span>{displayName}</span>
        </p>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="size-3 animate-spin" />
          <span>正在检查提供商状态...</span>
        </div>
      </div>
      <Badge variant="outline" className="shrink-0 text-text-muted">
        加载中...
      </Badge>
    </div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {Array.from({ length: 4 }, (_, index) => (
        <span
          key={index}
          className="h-7 w-28 animate-pulse rounded-md border border-border bg-surface"
        />
      ))}
    </div>
  </div>
);

function isProviderCapabilityCardLoading(
  provider: CliProviderStatus,
  providerLoading: boolean
): boolean {
  return (
    providerLoading ||
    (!provider.authenticated &&
      provider.statusMessage === 'Checking...' &&
      provider.models.length === 0 &&
      provider.backend == null)
  );
}

function isCodexSnapshotPending(
  provider: CliProviderStatus,
  codexSnapshotPending: boolean
): boolean {
  return provider.providerId === 'codex' && codexSnapshotPending;
}

const EXTENSION_SUB_TABS = [
  {
    value: 'plugins' as const,
    label: 'cc 扩展',
    icon: Puzzle,
    description: '为 Agent loop 注入工具、Skills、MCP 和连接器。',
  },
  {
    value: 'capability-packs' as const,
    label: '能力包',
    icon: Boxes,
    description: '本地 commands、skills metadata 和 workflows metadata 集合。',
  },
] as const;

export const ExtensionStoreView = (): React.JSX.Element => {
  const {
    bootstrapCliStatus,
    fetchCliStatus,
    fetchPluginCatalog,
    cliStatus,
    cliStatusLoading,
    cliProviderStatusLoading,
    appConfig,
    openDashboard,
    sessions,
    projects,
    repositoryGroups,
  } = useStore(
    useShallow((s) => ({
      bootstrapCliStatus: s.bootstrapCliStatus,
      fetchCliStatus: s.fetchCliStatus,
      fetchPluginCatalog: s.fetchPluginCatalog,
      pluginCatalog: s.pluginCatalog,
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      cliProviderStatusLoading: s.cliProviderStatusLoading,
      appConfig: s.appConfig,
      openDashboard: s.openDashboard,
      sessions: s.sessions,
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
    }))
  );
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? false;
  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );
  const codexAccount = useCodexAccountSnapshot({
    enabled:
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(
        loadingCliStatus?.providers.some(
          (provider: CliProviderStatus) => provider.providerId === 'codex'
        )
      ),
    includeRateLimits: true,
  });
  const codexSnapshotPending =
    codexAccount.loading &&
    Boolean(
      loadingCliStatus?.providers.some(
        (provider: CliProviderStatus) => provider.providerId === 'codex'
      )
    ) &&
    !codexAccount.snapshot;
  const effectiveCliStatus = useMemo(
    () =>
      loadingCliStatus
        ? {
            ...loadingCliStatus,
            providers: loadingCliStatus.providers.map((provider: CliProviderStatus) =>
              provider.providerId === 'codex'
                ? mergeCodexProviderStatusWithSnapshot(provider, codexAccount.snapshot)
                : provider
            ),
          }
        : loadingCliStatus,
    [loadingCliStatus, codexAccount.snapshot]
  );
  const effectiveCliStatusLoading = cliStatusLoading && effectiveCliStatus === null;
  const runtimeDisplayName = getRuntimeDisplayName(effectiveCliStatus, multimodelEnabled);
  const cliInstalled = effectiveCliStatus?.installed ?? true;
  const hasOngoingSessions = sessions.some((sess) => sess.isOngoing);

  const tabState = useExtensionsTabState();
  const tabId = useTabIdOptional();
  const extensionsTabProjectId = useStore((s) =>
    tabId
      ? (s.paneLayout.panes.flatMap((pane) => pane.tabs).find((tab) => tab.id === tabId)
          ?.projectId ?? null)
      : null
  );

  const resolvedProject = useMemo(
    () => resolveProjectPathById(extensionsTabProjectId, projects, repositoryGroups),
    [extensionsTabProjectId, projects, repositoryGroups]
  );
  const projectPath = resolvedProject?.path ?? null;
  const subTabs = EXTENSION_SUB_TABS;

  useEffect(() => {
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      bootstrapCliStatus,
      fetchCliStatus,
    });
  }, [bootstrapCliStatus, fetchCliStatus, multimodelEnabled]);

  // Fetch Plugin catalog on mount / project change
  useEffect(() => {
    void fetchPluginCatalog(projectPath ?? undefined);
  }, [fetchPluginCatalog, projectPath]);

  // Refresh all data
  const handleRefresh = useCallback(() => {
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      bootstrapCliStatus,
      fetchCliStatus,
      force: true,
    });
  }, [bootstrapCliStatus, fetchCliStatus, multimodelEnabled]);

  const isRefreshing = effectiveCliStatusLoading;
  const cliStatusBanner = useMemo(() => {
    const providers = effectiveCliStatus?.providers ?? [];
    const visibleProviders = filterExtensionStoreProviders(
      getVisibleMultimodelProviders(providers)
    );
    const isMultimodel = isMultimodelRuntimeStatus(effectiveCliStatus);
    const shouldShowMultimodelProviderCards =
      isMultimodel && visibleProviders.length > 0 && effectiveCliStatus !== null;

    if (
      (effectiveCliStatusLoading || effectiveCliStatus === null) &&
      !shouldShowMultimodelProviderCards
    ) {
      return (
        <div className="bg-surface/70 mx-4 mt-3 flex items-start gap-3 rounded-md border border-border px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-text-secondary" />
          <div>
            <p className="text-sm font-medium text-text">正在检查 cc 扩展运行时可用性</p>
            <p className="mt-0.5 text-xs text-text-muted">
              cc 扩展需要配置好的运行时来管理工具、Skills 和提供商连接。
            </p>
          </div>
        </div>
      );
    }

    if (shouldShowMultimodelProviderCards) {
      const loadingProviders = visibleProviders.filter(
        (provider) =>
          isProviderCapabilityCardLoading(
            provider,
            Boolean(cliProviderStatusLoading?.[provider.providerId])
          ) || isCodexSnapshotPending(provider, codexSnapshotPending)
      );
      if (loadingProviders.length > 0) {
        return (
          <div className="mx-4 mt-3 grid gap-2 md:grid-cols-2">
            {loadingProviders.map((provider) => (
              <ProviderCapabilityCardSkeleton
                key={provider.providerId}
                providerId={provider.providerId}
                displayName={provider.displayName}
              />
            ))}
          </div>
        );
      }
    }

    if (!effectiveCliStatus.installed) {
      const cliLaunchIssue = Boolean(
        effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
      );
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">
              {cliLaunchIssue ? '已找到配置的运行时，但启动失败' : '配置的运行时不可用'}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {cliLaunchIssue
                ? '运行时通过启动健康检查之前，扩展功能会保持禁用。请前往首页修复或重新安装。'
                : '安装运行时之前，扩展功能会保持禁用。请前往首页安装后重试。'}
            </p>
            {cliLaunchIssue && effectiveCliStatus.launchError && (
              <p className="mt-2 break-all font-mono text-[11px] text-text-muted">
                {effectiveCliStatus.launchError}
              </p>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            打开首页
          </Button>
        </div>
      );
    }

    if (!isMultimodel && !effectiveCliStatus.authLoggedIn) {
      return (
        <div className="mx-4 mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-300">{runtimeDisplayName} 需要登录</p>
            <p className="mt-0.5 text-xs text-text-muted">
              已找到 {runtimeDisplayName}
              {effectiveCliStatus.installedVersion
                ? ` (${effectiveCliStatus.installedVersion})`
                : ''}
              ，但登录前无法管理扩展。请前往首页登录。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openDashboard}>
            打开首页
          </Button>
        </div>
      );
    }

    return null;
  }, [
    cliProviderStatusLoading,
    codexSnapshotPending,
    effectiveCliStatus,
    effectiveCliStatusLoading,
    openDashboard,
    runtimeDisplayName,
  ]);

  const pageHeader = (
    <WorkbenchPageHeader
      title="扩展"
      description="管理 cc 扩展、Skills、MCP、连接器和能力包。"
      actions={
        api.plugins ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">刷新目录</span>
                <span className="sm:hidden">刷新</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新扩展目录</TooltipContent>
          </Tooltip>
        ) : undefined
      }
    />
  );

  // Browser mode guard
  if (!api.plugins) {
    return (
      <TooltipProvider>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-page-canvas">
          {pageHeader}
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="rounded-md border border-[var(--surface-border)] bg-[var(--color-surface)] px-8 py-10 text-center">
              <Puzzle className="mx-auto mb-3 size-8 text-text-muted" />
              <h2 className="text-sm font-medium text-text">浏览器模式暂不支持扩展管理</h2>
              <p className="mt-1 text-xs text-text-muted">请在桌面应用中管理和安装扩展。</p>
            </div>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-page-canvas">
        {pageHeader}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-7xl">
            {cliStatusBanner}

            {/* Sub-tabs */}
            <div className="p-4">
              {/* CLI not installed warning */}
              {!cliInstalled && (
                <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
                  <AlertTriangle className="size-4 shrink-0" />
                  安装或卸载扩展需要配置运行时。请前往首页安装或修复。
                </div>
              )}
              {/* Active sessions warning */}
              {hasOngoingSessions && (
                <div className="mb-4 flex items-center gap-2 rounded-md border border-indigo-500/30 bg-indigo-500/5 px-4 py-3 text-sm text-indigo-400">
                  <Info className="size-4 shrink-0" />
                  正在运行的会话需要重启后才会应用扩展变更。
                </div>
              )}
              <Tabs
                value={tabState.activeSubTab}
                onValueChange={(v) => tabState.setActiveSubTab(v as ExtensionsSubTab)}
              >
                <div className="-mx-4 flex items-end justify-between border-b border-border px-4">
                  <TabsList className="gap-1 rounded-b-none">
                    {subTabs.map((subTab) => (
                      <ExtensionsSubTabTrigger
                        key={subTab.value}
                        value={subTab.value}
                        label={subTab.label}
                        icon={subTab.icon}
                        description={subTab.description}
                      />
                    ))}
                  </TabsList>
                </div>

                <TabsContent value="plugins" className="mt-0 pt-4">
                  <PluginsPanel
                    projectPath={projectPath}
                    pluginFilters={tabState.pluginFilters}
                    pluginSort={tabState.pluginSort}
                    setPluginSort={tabState.setPluginSort}
                    selectedPluginId={tabState.selectedPluginId}
                    setSelectedPluginId={tabState.setSelectedPluginId}
                    updatePluginSearch={tabState.updatePluginSearch}
                    toggleCategory={tabState.toggleCategory}
                    toggleCapability={tabState.toggleCapability}
                    toggleInstalledOnly={tabState.toggleInstalledOnly}
                    clearFilters={tabState.clearFilters}
                    hasActiveFilters={tabState.hasActiveFilters}
                    cliStatus={effectiveCliStatus}
                    cliStatusLoading={effectiveCliStatusLoading}
                  />
                </TabsContent>

                <TabsContent value="capability-packs" className="mt-0 pt-4">
                  <CapabilityPacksPanel />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </div>
      <StoreExtensionToast />
    </TooltipProvider>
  );
};

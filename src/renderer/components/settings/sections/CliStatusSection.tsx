/**
 * CliStatusSection — CLI installation status and install/update controls.
 *
 * Displayed in Settings → Advanced, only in Electron mode.
 * Shows detection status, version info, download progress, and error states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { providersApi } from '@renderer/api/providers';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import {
  getProviderConnectLabel,
  getProviderDisconnectAction,
  shouldShowProviderConnectAction,
} from '@renderer/components/runtime/providerConnectionUi';
import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES } from '@renderer/components/team/HarnessCards';
import { HarnessIcon } from '@renderer/components/team/HarnessSelect';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { useCliInstaller } from '@renderer/hooks/useCliInstaller';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { getMainScreenCliProviders } from '@renderer/utils/claudeCodeOnlyProviders';
import { formatBytes } from '@renderer/utils/formatters';
import { emitOpenHermitEvent, OPEN_HERMIT_EVENTS } from '@renderer/utils/openHermitEvents';
import { resolveProjectPathById } from '@renderer/utils/projectLookup';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';
import {
  AlertTriangle,
  CheckCircle,
  Download,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';

import { SettingsSectionHeader } from '../components';

import type { CliProviderId, CliProviderStatus } from '@shared/types';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';
import type { GlobalProvider } from '@shared/types/providers';

const CLI_PROVIDER_BY_AGENT_TYPE: Partial<Record<HermitBridgeAgentType, CliProviderId>> = {
  claudecode: 'anthropic',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

const ProviderBetaBadge = (): React.JSX.Element => (
  <span
    className="inline-flex h-4 shrink-0 items-center rounded border px-1.5 text-[9px] font-semibold uppercase leading-none"
    style={{
      borderColor: 'rgba(251, 191, 36, 0.32)',
      backgroundColor: 'rgba(251, 191, 36, 0.12)',
      color: '#fbbf24',
    }}
  >
    beta
  </span>
);

function getProviderLabel(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (75+ LLM providers)';
  }
}

function getProviderTerminalCommand(provider: CliProviderStatus): {
  args: string[];
  env?: Record<string, string>;
} {
  if (provider.providerId === 'gemini') {
    return {
      args: ['login'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  if (provider.providerId === 'codex') {
    return {
      args: ['auth', 'login', '--provider', provider.providerId],
      env: {
        CLAUDE_CODE_CODEX_BACKEND: provider.selectedBackendId ?? 'codex-native',
      },
    };
  }

  return {
    args: ['auth', 'login', '--provider', provider.providerId],
  };
}

function getProviderTerminalLogoutCommand(provider: CliProviderStatus): {
  args: string[];
  env?: Record<string, string>;
} {
  if (provider.providerId === 'gemini') {
    return {
      args: ['logout'],
      env: {
        CLAUDE_CODE_ENTRY_PROVIDER: 'gemini',
        CLAUDE_CODE_GEMINI_BACKEND: provider.selectedBackendId ?? 'auto',
      },
    };
  }

  if (provider.providerId === 'codex') {
    return {
      args: ['auth', 'logout', '--provider', provider.providerId],
      env: {
        CLAUDE_CODE_CODEX_BACKEND: provider.selectedBackendId ?? 'codex-native',
      },
    };
  }

  return {
    args: ['auth', 'logout', '--provider', provider.providerId],
  };
}

interface CliStatusSectionProps {
  showSectionHeader?: boolean;
}

export const CliStatusSection = ({
  showSectionHeader = true,
}: CliStatusSectionProps): React.JSX.Element | null => {
  const appConfig = useStore((s) => s.appConfig);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const repositoryGroups = useStore((s) => s.repositoryGroups);
  const updateConfig = useStore((s) => s.updateConfig);
  const {
    cliStatus,
    installerState,
    downloadProgress,
    downloadTransferred,
    downloadTotal,
    installerError,
    completedVersion,
    bootstrapCliStatus,
    fetchCliStatus,
    fetchCliProviderStatus,
    installCli,
    isBusy,
    cliStatusLoading,
    cliProviderStatusLoading,
    invalidateCliStatus,
  } = useCliInstaller();
  const [providerTerminal, setProviderTerminal] = useState<{
    providerId: CliProviderId;
    action: 'login' | 'logout';
  } | null>(null);
  const [manageProviderId, setManageProviderId] = useState<CliProviderId>('gemini');
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [genericHarnessAgentType, setGenericHarnessAgentType] =
    useState<HermitBridgeAgentType | null>(null);
  const [globalProviders, setGlobalProviders] = useState<GlobalProvider[]>([]);
  const [globalProvidersLoading, setGlobalProvidersLoading] = useState(false);
  const [globalProvidersError, setGlobalProvidersError] = useState<string | null>(null);
  const multimodelEnabled = appConfig?.general?.multimodelEnabled ?? false;
  const selectedProjectPath = useMemo(
    () => resolveProjectPathById(selectedProjectId, projects, repositoryGroups)?.path ?? null,
    [projects, repositoryGroups, selectedProjectId]
  );
  const loadingCliStatus =
    !cliStatus && cliStatusLoading && multimodelEnabled
      ? createLoadingMultimodelCliStatus()
      : cliStatus;
  const effectiveCliStatus = loadingCliStatus;
  const visibleProviders = useMemo(
    () => getMainScreenCliProviders(effectiveCliStatus),
    [effectiveCliStatus]
  );
  const showInstalledControls =
    effectiveCliStatus !== null && (installerState === 'idle' || installerState === 'completed');

  useEffect(() => {
    if (!cliStatus) {
      if (multimodelEnabled) {
        void bootstrapCliStatus({ multimodelEnabled: true });
      } else {
        void fetchCliStatus();
      }
    }
  }, [bootstrapCliStatus, cliStatus, fetchCliStatus, multimodelEnabled]);

  const refreshGlobalProviders = useCallback(async (): Promise<void> => {
    setGlobalProvidersLoading(true);
    setGlobalProvidersError(null);
    try {
      const result = await providersApi.list();
      setGlobalProviders(result.providers ?? []);
    } catch (error) {
      setGlobalProvidersError(error instanceof Error ? error.message : '加载 Provider 失败');
      setGlobalProviders([]);
    } finally {
      setGlobalProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGlobalProviders();
  }, [refreshGlobalProviders]);

  const handleInstall = useCallback(() => {
    installCli();
  }, [installCli]);

  const handleRefresh = useCallback(() => {
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      bootstrapCliStatus,
      fetchCliStatus,
      force: true,
    });
  }, [bootstrapCliStatus, fetchCliStatus, multimodelEnabled]);

  const handleProviderLogout = useCallback(
    async (providerId: CliProviderId) => {
      const provider =
        effectiveCliStatus?.providers.find((entry) => entry.providerId === providerId) ?? null;
      const disconnectAction = provider ? getProviderDisconnectAction(provider) : null;
      if (!disconnectAction) {
        return;
      }

      const confirmed = await confirm({
        title: disconnectAction.title,
        message: disconnectAction.message,
        confirmLabel: disconnectAction.confirmLabel,
        cancelLabel: '取消',
        variant: 'danger',
      });

      if (!confirmed) {
        return;
      }

      setProviderTerminal({
        providerId,
        action: 'logout',
      });
    },
    [effectiveCliStatus?.providers]
  );

  const handleProviderManage = useCallback((providerId: CliProviderId) => {
    setManageProviderId(providerId);
    setManageDialogOpen(true);
  }, []);

  const handleProviderRefresh = useCallback(
    (providerId: CliProviderId) => fetchCliProviderStatus(providerId),
    [fetchCliProviderStatus]
  );

  const handleHarnessManage = useCallback(
    (agentType: HermitBridgeAgentType) => {
      const providerId = CLI_PROVIDER_BY_AGENT_TYPE[agentType];
      if (providerId && visibleProviders.some((provider) => provider.providerId === providerId)) {
        setManageProviderId(providerId);
        setManageDialogOpen(true);
        return;
      }
      setGenericHarnessAgentType(agentType);
    },
    [visibleProviders]
  );

  const recheckStatus = useCallback(() => {
    void (async () => {
      await invalidateCliStatus();
      await refreshCliStatusForCurrentMode({
        multimodelEnabled,
        bootstrapCliStatus,
        fetchCliStatus,
        force: true,
      });
    })();
  }, [bootstrapCliStatus, fetchCliStatus, invalidateCliStatus, multimodelEnabled]);

  const handleRuntimeBackendChange = useCallback(
    async (providerId: CliProviderId, backendId: string) => {
      const currentBackends = appConfig?.runtime?.providerBackends ?? {
        gemini: 'auto' as const,
        codex: 'codex-native' as const,
      };

      if (providerId !== 'gemini' && providerId !== 'codex') {
        return;
      }

      await updateConfig('runtime', {
        providerBackends: {
          ...currentBackends,
          [providerId]: backendId,
        },
      });

      try {
        await fetchCliProviderStatus(providerId);
      } catch {
        throw new Error('Runtime updated, but failed to refresh provider status.');
      }
    },
    [appConfig?.runtime?.providerBackends, fetchCliProviderStatus, updateConfig]
  );

  const runtimeDisplayName = getRuntimeDisplayName(effectiveCliStatus, multimodelEnabled);
  const runtimeLabel = '运行时';

  const activeTerminalProvider = providerTerminal
    ? (effectiveCliStatus?.providers.find(
        (provider) => provider.providerId === providerTerminal.providerId
      ) ?? null)
    : null;
  const providerTerminalCommand =
    providerTerminal && activeTerminalProvider
      ? providerTerminal.action === 'login'
        ? getProviderTerminalCommand(activeTerminalProvider)
        : getProviderTerminalLogoutCommand(activeTerminalProvider)
      : null;
  const cliProviderStatusByAgentType = useMemo(() => {
    const map = new Map<HermitBridgeAgentType, CliProviderStatus>();
    for (const agentType of ALL_AGENT_TYPES) {
      const providerId = CLI_PROVIDER_BY_AGENT_TYPE[agentType];
      const provider = providerId
        ? (visibleProviders.find((entry) => entry.providerId === providerId) ?? null)
        : null;
      if (provider) {
        map.set(agentType, provider);
      }
    }
    return map;
  }, [visibleProviders]);
  const globalProvidersByAgentType = useMemo(() => {
    const map = new Map<HermitBridgeAgentType, GlobalProvider[]>();
    for (const agentType of ALL_AGENT_TYPES) {
      map.set(
        agentType,
        globalProviders.filter((provider) =>
          ((provider.agent_types ?? []) as readonly string[]).some(
            (supportedType) => supportedType === agentType
          )
        )
      );
    }
    return map;
  }, [globalProviders]);

  return (
    <div className="mb-2">
      {showSectionHeader ? <SettingsSectionHeader title="Harness 配置" /> : null}
      <div className="space-y-3 py-2">
        {/* Loading status */}
        {!effectiveCliStatus && installerState === 'idle' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            {multimodelEnabled ? '正在检查 Harness 提供商...' : '正在检查 Harness 运行时...'}
          </div>
        )}

        {/* Status display */}
        {showInstalledControls && effectiveCliStatus && (
          <div className="space-y-2">
            {effectiveCliStatus.installed ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <Terminal
                    className="size-4 shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}
                  />
                  {runtimeLabel && (
                    <span style={{ color: 'var(--color-text)' }}>{runtimeLabel}</span>
                  )}
                </div>
                {effectiveCliStatus.showBinaryPath && effectiveCliStatus.binaryPath && (
                  <p
                    className="ml-6 truncate text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={effectiveCliStatus.binaryPath}
                  >
                    {effectiveCliStatus.binaryPath}
                  </p>
                )}
                <div className="mt-3 grid gap-2">
                  {ALL_AGENT_TYPES.map((agentType) => {
                    const provider = cliProviderStatusByAgentType.get(agentType) ?? null;
                    const harnessProviders = globalProvidersByAgentType.get(agentType) ?? [];
                    const hasProviders = harnessProviders.length > 0;

                    return (
                      <div
                        key={agentType}
                        className="flex items-center gap-3 rounded-lg border px-3.5 py-2.5 transition-colors"
                        style={{
                          borderColor: hasProviders
                            ? 'var(--color-border-emphasis)'
                            : 'var(--color-border-subtle)',
                          backgroundColor: 'var(--color-surface-raised)',
                          borderLeftWidth: hasProviders ? '2px' : '1px',
                          borderLeftColor: hasProviders
                            ? 'var(--color-accent)'
                            : 'var(--color-border-subtle)',
                        }}
                      >
                        <HarnessIcon type={agentType} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="truncate text-xs font-medium"
                              style={{ color: 'var(--color-text)' }}
                            >
                              {provider?.displayName ?? AGENT_TYPE_LABELS[agentType]}
                            </span>
                            {provider?.providerId === 'codex' ? <ProviderBetaBadge /> : null}
                          </div>
                          {hasProviders && (
                            <span
                              className="text-[10px]"
                              style={{ color: 'var(--color-text-muted)' }}
                            >
                              {harnessProviders.length} provider
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            provider
                              ? handleProviderManage(provider.providerId)
                              : handleHarnessManage(agentType)
                          }
                          className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5"
                          style={{
                            borderColor: 'var(--color-border-subtle)',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          <SlidersHorizontal className="size-3" />
                          配置
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0" style={{ color: '#fbbf24' }} />
                  {effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
                    ? `${runtimeDisplayName} was found but failed to start`
                    : `${runtimeDisplayName} not installed`}
                </div>
                {effectiveCliStatus.showBinaryPath && effectiveCliStatus.binaryPath && (
                  <div className="break-all font-mono text-xs text-text-muted">
                    {effectiveCliStatus.binaryPath}
                  </div>
                )}
                {effectiveCliStatus.launchError && (
                  <div
                    className="rounded border px-2 py-1.5 font-mono text-xs"
                    style={{
                      borderColor: 'rgba(245, 158, 11, 0.25)',
                      backgroundColor: 'rgba(245, 158, 11, 0.06)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {effectiveCliStatus.launchError}
                  </div>
                )}
              </div>
            )}

            {!effectiveCliStatus.installed && !effectiveCliStatus.supportsSelfUpdate && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {effectiveCliStatus.binaryPath && effectiveCliStatus.launchError
                  ? `已配置的 ${runtimeDisplayName} 未通过启动健康检查。`
                  : `未找到已配置的 ${runtimeDisplayName}。`}
              </p>
            )}
          </div>
        )}

        {/* Downloading */}
        {installerState === 'downloading' && (
          <div className="space-y-2">
            <div
              className="flex items-center justify-between text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <span>正在下载...</span>
              <span>
                {downloadTotal > 0
                  ? `${formatBytes(downloadTransferred)} / ${formatBytes(downloadTotal)} (${downloadProgress}%)`
                  : `${formatBytes(downloadTransferred)}`}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              {downloadTotal > 0 ? (
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress}%`,
                    backgroundColor: '#6366f1',
                  }}
                />
              ) : (
                <div
                  className="h-full w-1/3 animate-pulse rounded-full"
                  style={{ backgroundColor: '#6366f1' }}
                />
              )}
            </div>
          </div>
        )}

        {/* Checking */}
        {installerState === 'checking' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Checking latest version...
          </div>
        )}

        {/* Verifying */}
        {installerState === 'verifying' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            Verifying checksum...
          </div>
        )}

        {/* Installing */}
        {installerState === 'installing' && (
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Loader2 className="size-4 animate-spin" />
            正在安装...
          </div>
        )}

        {/* Completed */}
        {installerState === 'completed' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: '#4ade80' }}>
            <CheckCircle className="size-4" />
            已安装 v{completedVersion ?? 'latest'}
          </div>
        )}

        {/* Error */}
        {installerState === 'error' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: '#f87171' }}>
              <AlertTriangle className="size-4" />
              {installerError ?? '安装失败'}
            </div>
            <button
              onClick={handleInstall}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <RefreshCw className="size-3.5" />
              重试
            </button>
          </div>
        )}
      </div>
      <ProviderRuntimeSettingsDialog
        open={manageDialogOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setManageDialogOpen(false);
        }}
        providers={visibleProviders.filter((provider) => provider.providerId === manageProviderId)}
        projectPath={selectedProjectPath}
        initialProviderId={manageProviderId}
        providerStatusLoading={cliProviderStatusLoading}
        disabled={isBusy || cliStatusLoading}
        onSelectBackend={handleRuntimeBackendChange}
        onRefreshProvider={handleProviderRefresh}
        onRequestLogin={(providerId) => setProviderTerminal({ providerId, action: 'login' })}
      />
      <GenericHarnessProviderDialog
        agentType={genericHarnessAgentType}
        providers={
          genericHarnessAgentType
            ? (globalProvidersByAgentType.get(genericHarnessAgentType) ?? [])
            : []
        }
        loading={globalProvidersLoading}
        error={globalProvidersError}
        onRefresh={() => void refreshGlobalProviders()}
        onClose={() => setGenericHarnessAgentType(null)}
      />
    </div>
  );
};

interface GenericHarnessProviderDialogProps {
  agentType: HermitBridgeAgentType | null;
  providers: GlobalProvider[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

const GenericHarnessProviderDialog = ({
  agentType,
  providers,
  loading,
  error,
  onRefresh,
  onClose,
}: GenericHarnessProviderDialogProps): React.JSX.Element => {
  const open = agentType !== null;
  const title = agentType ? AGENT_TYPE_LABELS[agentType] : 'Harness';
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [newProviderModel, setNewProviderModel] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [addProviderError, setAddProviderError] = useState<string | null>(null);

  const handleAddProvider = async (): Promise<void> => {
    if (!agentType || !newProviderName.trim()) {
      setAddProviderError('请填写 Provider 名称');
      return;
    }
    setAddingProvider(true);
    setAddProviderError(null);
    try {
      await providersApi.add({
        name: newProviderName.trim(),
        api_key: newProviderApiKey.trim() || undefined,
        base_url: newProviderBaseUrl.trim() || undefined,
        model: newProviderModel.trim() || undefined,
        agent_types: [agentType],
      });
      setNewProviderName('');
      setNewProviderApiKey('');
      setNewProviderBaseUrl('');
      setNewProviderModel('');
      onRefresh();
      emitOpenHermitEvent(OPEN_HERMIT_EVENTS.providersChanged);
    } catch (err) {
      setAddProviderError(err instanceof Error ? err.message : '添加 Provider 失败');
    } finally {
      setAddingProvider(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="w-[min(92vw,760px)] max-w-[min(92vw,760px)]">
        <DialogHeader>
          <DialogTitle>{title} 配置</DialogTitle>
          <DialogDescription>
            当前 Harness 支持多个 Provider。这里展示已绑定到该 Agent 类型的模型、端点和凭据状态。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            className="space-y-3 rounded-lg border p-3"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                新增 Provider
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                保存后会自动绑定到 {title}。
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={newProviderName}
                onChange={(event) => setNewProviderName(event.target.value)}
                placeholder="Provider 名称，例如 deepseek"
              />
              <Input
                value={newProviderModel}
                onChange={(event) => setNewProviderModel(event.target.value)}
                placeholder="默认模型（可选）"
              />
              <Input
                value={newProviderBaseUrl}
                onChange={(event) => setNewProviderBaseUrl(event.target.value)}
                placeholder="Base URL（可选）"
              />
              <Input
                type="password"
                value={newProviderApiKey}
                onChange={(event) => setNewProviderApiKey(event.target.value)}
                placeholder="API Key（可选）"
              />
            </div>
            {addProviderError ? (
              <div className="text-xs text-red-400">{addProviderError}</div>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleAddProvider()}
                disabled={addingProvider}
                className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {addingProvider ? <Loader2 className="size-3 animate-spin" /> : null}
                添加 Provider
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Agent 类型：{agentType ?? '-'}
            </div>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <RefreshCw className={loading ? 'size-3 animate-spin' : 'size-3'} />
              刷新
            </button>
          </div>

          {error ? (
            <div
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: 'rgba(248, 113, 113, 0.25)',
                backgroundColor: 'rgba(248, 113, 113, 0.06)',
                color: '#fca5a5',
              }}
            >
              {error}
            </div>
          ) : null}

          {loading && providers.length === 0 ? (
            <div
              className="flex items-center gap-2 rounded-md border p-3 text-xs"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-muted)',
              }}
            >
              <Loader2 className="size-3 animate-spin" />
              正在加载 Provider...
            </div>
          ) : providers.length > 0 ? (
            <div className="space-y-2">
              {providers.map((provider) => {
                const endpoint =
                  (agentType
                    ? (provider.endpoints as Record<string, string | undefined> | undefined)?.[
                        agentType
                      ]
                    : undefined) ??
                  provider.base_url ??
                  '默认端点';
                const model =
                  (agentType
                    ? (provider.agent_models as Record<string, string | undefined> | undefined)?.[
                        agentType
                      ]
                    : undefined) ??
                  provider.model ??
                  provider.models?.[0]?.model ??
                  '未指定模型';
                return (
                  <div
                    key={provider.name}
                    className="rounded-lg border px-3.5 py-2.5"
                    style={{
                      borderColor: provider.api_key
                        ? 'var(--color-border)'
                        : 'var(--color-border-subtle)',
                      backgroundColor: 'var(--color-surface-raised)',
                      borderLeftWidth: provider.api_key ? '2px' : '1px',
                      borderLeftColor: provider.api_key
                        ? 'var(--color-accent)'
                        : 'var(--color-border-subtle)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: provider.api_key ? 'var(--color-accent)' : '#fbbf24',
                          }}
                        />
                        <span
                          className="text-sm font-medium"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {provider.name}
                        </span>
                      </div>
                      <span
                        className="text-[10px]"
                        style={{
                          color: provider.api_key ? 'var(--color-accent)' : '#fbbf24',
                        }}
                      >
                        {provider.api_key ? 'Key 已配置' : '未配置'}
                      </span>
                    </div>
                    <div
                      className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <span>端点：{endpoint}</span>
                      <span>模型：{model}</span>
                      {provider.thinking ? <span>Thinking：{provider.thinking}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              className="rounded-md border p-3 text-xs"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-muted)',
              }}
            >
              当前还没有绑定到 {title} 的 Provider。请在 AgentPanel 配置中添加 `agent_types` 包含 `
              {agentType ?? 'agent'}` 的 Provider。
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

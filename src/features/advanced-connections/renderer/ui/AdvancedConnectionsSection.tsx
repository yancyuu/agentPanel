import { useState } from 'react';

import {
  AlertTriangle,
  Check,
  ChevronRight,
  Cloud,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import {
  type AdvancedConnectionSummary,
  type AdvancedConnectionTokenCatalogSummary,
  type DiscoverAdvancedConnectionResponse,
} from '../../contracts';

import type { AdvancedConnectionOperationOutcome } from '../hooks/useAdvancedConnections';

interface AdvancedConnectionsSectionProps {
  connections: AdvancedConnectionSummary[];
  host: string;
  preview: DiscoverAdvancedConnectionResponse | null;
  loading: boolean;
  busyAction: string | null;
  error: string | null;
  notice: string | null;
  catalogStatus: Record<string, AdvancedConnectionOperationOutcome>;
  catalogs: Record<string, AdvancedConnectionTokenCatalogSummary | undefined>;
  channelStatus: Record<string, AdvancedConnectionOperationOutcome>;
  onHostChange: (value: string) => void;
  onDiscover: () => void;
  onAddConnection: () => void;
  onRemoveConnection: (connectionId: string) => void;
  onStartAuth: (connection: AdvancedConnectionSummary) => void;
  onLogout: (connectionId: string) => void;
  /** 用户确认 HTTP 传输风险后持久化放行（per-connection） */
  onAllowInsecure: (connectionId: string) => void;
  onSyncConnection: (connectionId: string) => void;
  onPullRemoteTasks: (connectionId: string) => void;
  onCheckTokenCatalog: (connectionId: string) => void;
  onClaimAndApplyToken: (connectionId: string) => void;
  onRefresh: () => void;
}

function OutcomeLine({
  outcome,
}: Readonly<{ outcome: AdvancedConnectionOperationOutcome }>): React.JSX.Element {
  const time = new Date(outcome.at);
  const timeLabel = Number.isNaN(time.getTime())
    ? ''
    : time.toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <p
      className={`mt-2 flex items-start gap-1.5 text-[11px] leading-4 ${
        outcome.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
      }`}
      data-testid="operation-outcome"
    >
      {outcome.ok ? (
        <Check className="mt-0.5 size-3 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{outcome.text}</span>
      {timeLabel ? (
        <span className="shrink-0 text-[var(--color-text-muted)]">{timeLabel}</span>
      ) : null}
    </p>
  );
}

const STATE_LABELS: Record<AdvancedConnectionSummary['state'], string> = {
  discovered: '已发现',
  auth_required: '等待登录',
  authenticating: '正在授权',
  authenticated: '已登录',
  ready: '已就绪',
  connected: '已连接',
  degraded: '部分能力异常',
  error: '连接异常',
};

function connectionAllowsSecrets(connection: AdvancedConnectionSummary): boolean {
  if (connection.secure) return true;
  try {
    const hostname = new URL(connection.baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function AdvancedConnectionsSection({
  connections,
  host,
  preview,
  loading,
  busyAction,
  error,
  notice,
  catalogStatus,
  catalogs,
  channelStatus,
  onHostChange,
  onDiscover,
  onAddConnection,
  onRemoveConnection,
  onStartAuth,
  onLogout,
  onAllowInsecure,
  onSyncConnection,
  onPullRemoteTasks,
  onCheckTokenCatalog,
  onClaimAndApplyToken,
  onRefresh,
}: Readonly<AdvancedConnectionsSectionProps>): React.JSX.Element {
  // 等待用户确认 HTTP 传输风险的连接 id（确认后按连接持久化，不再重复询问）
  const [insecureConfirmId, setInsecureConfirmId] = useState<string | null>(null);
  const insecureConfirmConnection = insecureConfirmId
    ? (connections.find((connection) => connection.id === insecureConfirmId) ?? null)
    : null;
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Cloud className="size-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">开放连接</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                连接公司 AgentBus 或其他兼容服务。服务声明可用的登录、团队总线、数据上报和 Token
                池能力，你再逐项授权。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <label
            className="block text-xs font-medium text-[var(--color-text-secondary)]"
            htmlFor="advanced-connection-host"
          >
            服务地址
          </label>
          <div className="flex min-w-0 gap-2">
            <input
              id="advanced-connection-host"
              value={host}
              onChange={(event) => onHostChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && host.trim()) onDiscover();
              }}
              placeholder="https://agentbus.company.example"
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent-border)]"
            />
            <button
              type="button"
              disabled={!host.trim() || busyAction === 'discover'}
              onClick={onDiscover}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'discover' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Server className="size-3.5" />
              )}
              检测服务
            </button>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
            <p className="font-medium text-[var(--color-text-secondary)]">系统如何判定兼容服务</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>
                先读取 <code>/.well-known/hermit-provider.json</code>；合法声明会识别为标准
                Provider。
              </li>
              <li>
                如果该地址返回 404、网页内容或无法解析的 JSON，系统会继续探测
                <code>/api/v1/auth/me</code>。
              </li>
              <li>如果登录探测返回 401 或 403，会识别为“需要登录”的 AgentBus 兼容服务。</li>
              <li>两种探测都失败时，系统会提示该地址暂不受支持。</li>
            </ol>
          </div>

          {preview ? (
            <div className="rounded-lg border border-[var(--color-accent-border)] bg-[var(--color-accent-soft)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-[var(--color-text)]">
                      {preview.manifest.provider.displayName}
                    </p>
                    {preview.compatibilityMode ? (
                      <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                        AgentBus 兼容模式
                      </span>
                    ) : null}
                    {!preview.secure ? (
                      <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">
                        <AlertTriangle className="size-3" />
                        HTTP
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    {preview.baseUrl}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {preview.manifest.capabilities.map((capability) => (
                      <span
                        key={capability.id}
                        className="rounded-md bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                      >
                        {capability.displayName}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyAction === 'create'}
                  onClick={onAddConnection}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-accent-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-accent)] disabled:opacity-50"
                >
                  {busyAction === 'create' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  添加连接
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-500">
          {notice}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-[var(--color-text)]">已添加的连接</h3>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            没有连接时，本地工作台仍可完整使用。
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="grid size-8 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label="刷新连接状态"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          正在读取连接…
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
          尚未添加远程连接。
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map((connection) => {
            const authenticated =
              connection.secretPresent &&
              ['authenticated', 'ready', 'connected'].includes(connection.state);
            const tokenPool = connection.capabilities.some((item) => item.id === 'token-pool');
            // HTTPS 或回环地址直接允许；其余 HTTP 需用户先确认传输风险（per-connection 持久化）
            const transportReady =
              connectionAllowsSecrets(connection) || connection.insecureAllowed;
            const catalog = catalogs[connection.id];
            return (
              <article
                key={connection.id}
                className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]"
              >
                <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="truncate text-sm font-semibold text-[var(--color-text)]">
                        {connection.label}
                      </h4>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] ${connection.state === 'error' ? 'bg-red-500/10 text-red-400' : authenticated ? 'bg-emerald-500/10 text-emerald-500' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}
                      >
                        {STATE_LABELS[connection.state]}
                      </span>
                      {!connection.secure ? (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">
                          非加密 HTTP
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">
                      {connection.providerName} · {connection.baseUrl}
                    </p>
                    {connection.account ? (
                      <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                        当前账号：
                        {connection.account.displayName ||
                          connection.account.email ||
                          connection.account.id ||
                          '已授权用户'}
                        {connection.account.tenantName ? ` · ${connection.account.tenantName}` : ''}
                      </p>
                    ) : null}
                    {connection.lastError ? (
                      <p className="mt-2 text-[11px] text-red-400">
                        {connection.lastError.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {authenticated ? (
                      <button
                        type="button"
                        onClick={() => onLogout(connection.id)}
                        disabled={busyAction === `logout:${connection.id}`}
                        className="grid size-8 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        aria-label="退出登录"
                      >
                        {busyAction === `logout:${connection.id}` ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <LogOut className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`auth:${connection.id}`}
                        onClick={() => {
                          if (!transportReady) {
                            setInsecureConfirmId(connection.id);
                            return;
                          }
                          onStartAuth(connection);
                        }}
                        disabled={
                          busyAction === `auth:${connection.id}` ||
                          connection.state === 'authenticating'
                        }
                        className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {busyAction === `auth:${connection.id}` ||
                        connection.state === 'authenticating' ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <KeyRound className="size-3.5" />
                        )}
                        {connection.state === 'authenticating' ? '等待授权' : '登录授权'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveConnection(connection.id)}
                      disabled={busyAction === `remove:${connection.id}`}
                      className="grid size-8 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-red-500/30 hover:text-red-400"
                      aria-label="删除连接"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                <div className="p-4">
                  <div>
                    <p className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                      服务能力
                    </p>
                    <div className="mt-2 space-y-2">
                      {connection.capabilities.map((capability) => (
                        <div
                          key={capability.id}
                          className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"
                        >
                          <Check className="size-3.5 text-emerald-500" />
                          {capability.displayName}
                        </div>
                      ))}
                    </div>
                    {connection.capabilities.some(
                      (item) => item.id === 'team-bus' || item.id === 'reporting'
                    ) ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!authenticated || busyAction === `sync:${connection.id}`}
                          onClick={() => onSyncConnection(connection.id)}
                          className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] disabled:opacity-45"
                        >
                          {busyAction === `sync:${connection.id}` ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          同步已授权数据
                        </button>
                        {connection.capabilities.some((item) => item.id === 'team-bus') ? (
                          <button
                            type="button"
                            disabled={!authenticated || busyAction === `pull:${connection.id}`}
                            onClick={() => onPullRemoteTasks(connection.id)}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] disabled:opacity-45"
                          >
                            {busyAction === `pull:${connection.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Server className="size-3.5" />
                            )}
                            检查远程任务
                          </button>
                        ) : null}
                        {channelStatus[connection.id] ? (
                          <OutcomeLine outcome={channelStatus[connection.id]} />
                        ) : null}
                      </div>
                    ) : null}
                    {tokenPool ? (
                      <div className="mt-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={
                              !authenticated ||
                              !transportReady ||
                              busyAction === `catalog:${connection.id}`
                            }
                            onClick={() => onCheckTokenCatalog(connection.id)}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] disabled:opacity-45"
                          >
                            {busyAction === `catalog:${connection.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="size-3.5" />
                            )}
                            检测 Token 池
                          </button>
                          <button
                            type="button"
                            disabled={
                              !authenticated ||
                              !transportReady ||
                              !catalog?.discoveryId ||
                              busyAction === `claim:${connection.id}`
                            }
                            onClick={() => onClaimAndApplyToken(connection.id)}
                            className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-white disabled:opacity-45"
                          >
                            {busyAction === `claim:${connection.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <KeyRound className="size-3.5" />
                            )}
                            领取并应用
                          </button>
                        </div>
                        {catalog?.defaultModelName ? (
                          <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
                            默认模型：{catalog.defaultModelName}；将应用到 Claude Code、Codex 和
                            Pi。
                          </p>
                        ) : null}
                        {catalogStatus[connection.id] ? (
                          <OutcomeLine outcome={catalogStatus[connection.id]} />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {insecureConfirmConnection ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="insecure-confirm-dialog"
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 shadow-floating">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
              <AlertTriangle className="size-4 text-amber-500" />
              非加密连接确认
            </h4>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              {insecureConfirmConnection.label}（{insecureConfirmConnection.baseUrl}）
              未使用加密传输，登录凭据在传输中可能被窃听。仍要继续吗？
            </p>
            <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
              确认后仅对该连接记住选择，之后不再询问。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setInsecureConfirmId(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  onAllowInsecure(insecureConfirmConnection.id);
                  setInsecureConfirmId(null);
                }}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
              >
                仍要继续
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

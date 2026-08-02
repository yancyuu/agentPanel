import { useCallback, useEffect, useState } from 'react';

import {
  AlertTriangle,
  Calendar,
  Check,
  Clock,
  Loader2,
  MessageSquare,
  Play,
  Square,
  Upload,
  UsersRound,
  Zap,
} from 'lucide-react';

import { SettingsSectionHeader } from '../components';

import type {
  CapabilityTelemetrySummary,
  TeamCapabilityTelemetrySnapshot,
} from '@shared/types/extensions';

interface ProviderMetrics {
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  tokensTotal: number;
}

interface TelemetryStatus {
  connected: boolean;
  lastScan: string | null;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  recentMessages?: number;
  recentTokensTotal?: number;
  recentByProvider?: { claudecode: ProviderMetrics; codex: ProviderMetrics; pi: ProviderMetrics };
  byProvider?: { claudecode: ProviderMetrics; codex: ProviderMetrics; pi: ProviderMetrics };
  activeDays: number;
  hourly: number[];
  projects: {
    cwd: string;
    displayName?: string;
    teamSlug?: string;
    bindProject?: string;
    deletedAt?: string;
    sessions: number;
    messages: number;
    tokensIn: number;
    tokensOut: number;
    tokensTotal: number;
  }[];
  workSecondsByDay: Record<string, number>;
  localUsers?: UsageUserRow[];
  teamCapabilitySnapshots?: TeamCapabilityTelemetrySnapshot[];
  capabilitySummary?: CapabilityTelemetrySummary;
  unresolvedUsage?: { sessions: number; messages: number; tokensTotal: number };
}

interface UsageUserRow {
  key: string;
  kind: 'local' | 'unresolved';
  identity: {
    platform: string;
    type: 'person' | 'group' | 'unknown';
    displayName: string;
    userId?: string;
    userName?: string;
    chatId?: string;
    chatName?: string;
    confidence: string;
  };
  teamSlug?: string;
  teamName?: string;
  teamDisplayName?: string;
  projectName?: string;
  bindProject?: string;
  workDir?: string;
  agentType?: string;
  model?: string;
  provider?: string;
  sessions: number;
  messages: number;
  tokensTotal: number;
  lastActiveAt?: string;
}

function formatNum(n: number | undefined): string {
  if (n == null) return '采集中...';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

type CapabilityAsset = TeamCapabilityTelemetrySnapshot['assets'][number];
type CapabilityAssetKind = CapabilityAsset['kind'];

const CAPABILITY_KIND_LABELS: Record<CapabilityAssetKind, string> = {
  command: 'Commands',
  skill: 'Skills',
  workflow: 'Workflows',
  cron: 'Cron',
  mcp: 'MCP',
};
const CAPABILITY_KIND_ORDER: CapabilityAssetKind[] = [
  'skill',
  'workflow',
  'cron',
  'mcp',
  'command',
];

const UsageDashboard = ({ status }: { status: TelemetryStatus }): React.JSX.Element => {
  const maxHourly = Math.max(...status.hourly, 1);
  const recentDays = Object.keys(status.workSecondsByDay).sort().slice(-7);
  const maxWorkSecs = Math.max(...Object.values(status.workSecondsByDay), 1);

  return (
    <div className="space-y-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Loop 使用概览</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          本地 Loop 数据（最近 7 天与全部历史）
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={<MessageSquare size={14} />}
          label="采集会话"
          value={formatNum(status.sessions)}
        />
        <StatCard
          icon={<MessageSquare size={14} />}
          label="Messages"
          value={formatNum(status.messages)}
        />
        <StatCard
          icon={<Zap size={14} />}
          label="Tokens（近7天）"
          value={formatNum(status.recentTokensTotal ?? status.totalTokens)}
        />
        <StatCard
          icon={<Zap size={14} />}
          label="Claude/Codex/Pi"
          value={`CC ${formatNum(status.recentByProvider?.claudecode?.tokensTotal)} / Codex ${formatNum(status.recentByProvider?.codex?.tokensTotal)} / Pi ${formatNum(status.recentByProvider?.pi?.tokensTotal)}`}
        />
        <StatCard icon={<Zap size={14} />} label="Input" value={formatNum(status.tokensIn)} />
        <StatCard icon={<Zap size={14} />} label="Output" value={formatNum(status.tokensOut)} />
        <StatCard icon={<Calendar size={14} />} label="活跃天" value={String(status.activeDays)} />
        <StatCard icon={<Zap size={14} />} label="Cache Read" value={formatNum(status.cacheRead)} />
        <StatCard
          icon={<Zap size={14} />}
          label="Cache Create"
          value={formatNum(status.cacheCreation)}
        />
        <StatCard
          icon={<Clock size={14} />}
          label="最近采集"
          value={status.lastScan ? new Date(status.lastScan).toLocaleDateString('zh-CN') : '-'}
        />
      </div>

      <div>
        <div className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
          24小时 Messages 分布
        </div>
        <div className="flex h-16 items-end gap-0.5">
          {status.hourly.map((count, i) => {
            const pct = (count / maxHourly) * 100;
            return (
              <div
                key={i}
                className="flex-1 rounded-sm bg-[var(--color-accent-muted)] transition-all hover:bg-[var(--color-accent)]"
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`${i}:00 - ${count} messages`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)]">
          <span>0h</span>
          <span>6h</span>
          <span>12h</span>
          <span>18h</span>
          <span>24h</span>
        </div>
      </div>

      {recentDays.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
            日工作时长（近 {recentDays.length} 天）
          </div>
          <div className="flex h-16 items-end gap-1">
            {recentDays.map((day) => {
              const secs = status.workSecondsByDay[day] ?? 0;
              const pct = (secs / maxWorkSecs) * 100;
              const label = day.slice(5);
              return (
                <div key={day} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {formatDuration(secs)}
                  </span>
                  <div
                    className="w-full rounded-sm bg-emerald-500/60 transition-all hover:bg-emerald-500"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                    title={`${day} - ${formatDuration(secs)}`}
                  />
                  <span className="text-[10px] text-[var(--color-text-muted)]">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <UsageUserTable title="本地生成用量（source=local）" rows={status.localUsers ?? []} />
      <CapabilitySnapshotTable
        summary={status.capabilitySummary}
        snapshots={status.teamCapabilitySnapshots ?? []}
      />
      {status.unresolvedUsage && status.unresolvedUsage.sessions > 0 && (
        <div className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          未映射会话：{status.unresolvedUsage.sessions} sessions ·{' '}
          {formatNum(status.unresolvedUsage.messages)} messages ·{' '}
          {formatNum(status.unresolvedUsage.tokensTotal)} tokens
        </div>
      )}
    </div>
  );
};

const UsageUserTable = ({
  rows,
  title,
}: {
  title: string;
  rows: UsageUserRow[];
}): React.JSX.Element => {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{title}</div>
      {rows.length === 0 ? (
        <div className="rounded bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          暂无数据
        </div>
      ) : (
        <UsageUserRows rows={rows} />
      )}
    </div>
  );
};

function getUsageProjectName(row: UsageUserRow): string {
  return row.projectName || row.teamDisplayName || row.teamName || row.identity.displayName;
}

function normalizeUsageProjectPath(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+$/g, '');
}

function getUsageProjectPath(row: UsageUserRow): string {
  return normalizeUsageProjectPath(
    row.workDir || row.bindProject || row.projectName || row.identity.confidence
  );
}

function mergeUsageProjectName(existing: UsageUserRow, row: UsageUserRow): string {
  const existingName = getUsageProjectName(existing);
  const nextName = getUsageProjectName(row);
  return existingName.length >= nextName.length ? existingName : nextName;
}

function aggregateUsageRowsByProject(rows: UsageUserRow[]): UsageUserRow[] {
  const grouped = new Map<string, UsageUserRow>();

  for (const row of rows) {
    const projectPath = getUsageProjectPath(row);
    const projectName = getUsageProjectName(row);
    const key = projectPath || projectName;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...row,
        key,
        identity: {
          ...row.identity,
          displayName: projectName,
        },
        workDir: projectPath,
      });
      continue;
    }

    const displayName = mergeUsageProjectName(existing, row);
    grouped.set(key, {
      ...existing,
      identity: {
        ...existing.identity,
        displayName,
      },
      sessions: existing.sessions + row.sessions,
      messages: existing.messages + row.messages,
      tokensTotal: existing.tokensTotal + row.tokensTotal,
      lastActiveAt:
        !existing.lastActiveAt || (row.lastActiveAt && row.lastActiveAt > existing.lastActiveAt)
          ? row.lastActiveAt
          : existing.lastActiveAt,
    });
  }

  return Array.from(grouped.values()).sort((a, b) => b.tokensTotal - a.tokensTotal);
}

const UsageUserRows = ({ rows }: { rows: UsageUserRow[] }): React.JSX.Element => {
  const projectRows = aggregateUsageRowsByProject(rows);

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {projectRows.map((row) => (
        <div
          key={row.key}
          className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-2 text-xs"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-[var(--color-text-secondary)]" title={row.key}>
              <span className="block truncate font-medium">{row.identity.displayName}</span>
              <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                {row.workDir ||
                  row.projectName ||
                  row.teamDisplayName ||
                  row.teamName ||
                  row.identity.confidence}
              </span>
              {row.identity.chatName && (
                <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                  群：{row.identity.chatName}
                </span>
              )}
            </span>
            <span className="shrink-0 text-right text-[10px] text-[var(--color-text-muted)]">
              <span className="block uppercase">{row.identity.platform}</span>
              <span className="block">
                {formatNum(row.messages)} msg · {formatNum(row.tokensTotal)} tokens
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

const CapabilityCountPills = ({
  counts,
}: {
  counts: TeamCapabilityTelemetrySnapshot['counts'];
}): React.JSX.Element => {
  const items = [
    ['Skills', counts.skills],
    ['Workflows', counts.workflows],
    ['Cron', counts.cron],
    ['MCP', counts.mcpServers],
    ['Commands', counts.commands],
  ] as const;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {items.map(([label, value]) => (
        <span
          key={label}
          className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
        >
          {label} {value}
        </span>
      ))}
    </span>
  );
};

const CapabilitySnapshotTable = ({
  snapshots,
  summary,
}: {
  summary?: CapabilityTelemetrySummary;
  snapshots: TeamCapabilityTelemetrySnapshot[];
}): React.JSX.Element => {
  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  const [expandedKinds, setExpandedKinds] = useState<Record<string, boolean>>({});
  if (snapshots.length === 0) return <></>;

  const counts = summary ?? {
    teams: snapshots.length,
    commands: snapshots.reduce((total, item) => total + item.counts.commands, 0),
    skills: snapshots.reduce((total, item) => total + item.counts.skills, 0),
    workflows: snapshots.reduce((total, item) => total + item.counts.workflows, 0),
    cron: snapshots.reduce((total, item) => total + item.counts.cron, 0),
    mcpServers: snapshots.reduce((total, item) => total + item.counts.mcpServers, 0),
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-medium text-[var(--color-text-muted)]">
        <span>数字员工能力资产</span>
        <span className="text-[10px]">
          {formatNum(counts.teams)} agents · {formatNum(counts.skills)} skills ·{' '}
          {formatNum(counts.workflows)} workflows · {formatNum(counts.cron)} cron ·{' '}
          {formatNum(counts.mcpServers)} MCP
        </span>
      </div>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {snapshots.map((snapshot) => {
          const teamKey = snapshot.teamSlug || snapshot.teamName;
          const isTeamExpanded = expandedTeams[teamKey] ?? false;
          return (
            <div key={teamKey} className="rounded bg-[var(--color-bg)] p-2">
              <button
                type="button"
                className="flex w-full items-start justify-between gap-3 text-left text-xs"
                onClick={() =>
                  setExpandedTeams((prev) => ({ ...prev, [teamKey]: !isTeamExpanded }))
                }
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[var(--color-text-secondary)]">
                    {snapshot.teamDisplayName || snapshot.teamName}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                    {isTeamExpanded ? '收起能力明细' : '展开查看 Skills / Workflows / Cron / MCP'}
                  </span>
                </span>
                <CapabilityCountPills counts={snapshot.counts} />
              </button>
              {isTeamExpanded && (
                <div className="mt-2 space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
                  {CAPABILITY_KIND_ORDER.map((kind) => {
                    const assets = snapshot.assets.filter((asset) => asset.kind === kind);
                    if (assets.length === 0) return null;
                    const kindKey = `${teamKey}:${kind}`;
                    const isKindExpanded = expandedKinds[kindKey] ?? false;
                    return (
                      <div
                        key={kind}
                        className="rounded border border-[var(--color-border-subtle)] p-2 text-[10px]"
                      >
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 text-left"
                          onClick={() =>
                            setExpandedKinds((prev) => ({ ...prev, [kindKey]: !isKindExpanded }))
                          }
                        >
                          <span className="font-medium text-[var(--color-text-secondary)]">
                            {CAPABILITY_KIND_LABELS[kind]}
                          </span>
                          <span className="text-[var(--color-text-muted)]">
                            {assets.length} · {isKindExpanded ? '收起' : '展开'}
                          </span>
                        </button>
                        {isKindExpanded && (
                          <div className="mt-2 grid gap-1 sm:grid-cols-2">
                            {assets.map((asset) => (
                              <div
                                key={asset.id}
                                className="rounded bg-[var(--color-surface-raised)] px-2 py-1"
                              >
                                <div className="truncate text-[var(--color-text-secondary)]">
                                  {asset.name}
                                </div>
                                {asset.description && (
                                  <div className="truncate text-[var(--color-text-muted)]">
                                    {asset.description}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const StatCard = ({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}): React.JSX.Element => {
  return (
    <div className="flex flex-col gap-1 rounded bg-[var(--color-bg)] p-2">
      <div className="flex items-center gap-1 text-[var(--color-text-muted)]">
        {icon}
        <span className="text-[10px]">{label}</span>
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
};

interface TaskBusSettings {
  enabled?: boolean;
  collaboration?: boolean;
  telemetry?: {
    enabled?: boolean;
    platform?: string;
    uploadProviders?: string[];
    conversationUploadEnabled?: boolean;
  };
}

interface UsageControlOutcome {
  ok: boolean;
  at: string;
  text: string;
}

function outcomeTimeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function UsageControlOutcomeLine({
  outcome,
}: Readonly<{ outcome: UsageControlOutcome }>): React.JSX.Element {
  return (
    <p
      className={`flex items-start gap-1.5 text-[11px] leading-4 ${
        outcome.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
      }`}
      data-testid="usage-control-outcome"
    >
      {outcome.ok ? (
        <Check size={12} className="mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{outcome.text}</span>
      <span className="shrink-0 text-[var(--color-text-muted)]">
        {outcomeTimeLabel(outcome.at)}
      </span>
    </p>
  );
}

async function readTaskBusSettings(): Promise<TaskBusSettings> {
  const response = await fetch('/api/settings/task-bus');
  return (await response.json()) as TaskBusSettings;
}

async function writeTaskBusSettings(config: TaskBusSettings): Promise<void> {
  const response = await fetch('/api/settings/task-bus', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `保存失败（HTTP ${response.status}）`);
}

export const TaskBusSection = (): React.JSX.Element => {
  const [loading, setLoading] = useState(true);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus | null>(null);
  const [taskBus, setTaskBus] = useState<TaskBusSettings | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UsageControlOutcome | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [status, settings] = await Promise.all([
        fetch('/api/telemetry/status').then((r) => r.json()) as Promise<TelemetryStatus>,
        readTaskBusSettings(),
      ]);
      setTelemetryStatus(status);
      setTaskBus(settings);
    } catch {
      // 状态加载失败时保留旧视图
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runControl = useCallback(
    async (key: string, action: () => Promise<string>): Promise<void> => {
      setBusyAction(key);
      try {
        const text = await action();
        setOutcome({ ok: true, at: new Date().toISOString(), text });
        await load();
      } catch (error) {
        setOutcome({
          ok: false,
          at: new Date().toISOString(),
          text: error instanceof Error ? error.message : '操作失败',
        });
      } finally {
        setBusyAction(null);
      }
    },
    [load]
  );

  const setTelemetryEnabled = useCallback(
    (enabled: boolean): Promise<string> =>
      (async () => {
        const current = await readTaskBusSettings();
        await writeTaskBusSettings({
          ...current,
          telemetry: { ...(current.telemetry ?? {}), enabled },
        });
        return enabled
          ? '已开始采集（与 CLI usage start 等价）。'
          : '已停止采集（与 CLI usage stop 等价）。';
      })(),
    []
  );

  const setCollaboration = useCallback(
    (enabled: boolean): Promise<string> =>
      (async () => {
        const current = await readTaskBusSettings();
        await writeTaskBusSettings({ ...current, collaboration: enabled });
        return enabled
          ? '团队协作已启用：团队指令已同步注入各工作区。'
          : '团队协作已停用：团队指令已从各工作区移除。';
      })(),
    []
  );

  const scanNow = useCallback(
    (): Promise<string> =>
      (async () => {
        const response = await fetch('/api/telemetry/scan', { method: 'POST' });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          sessions?: number;
          messages?: number;
          totalTokens?: number;
        };
        if (!response.ok) throw new Error(payload.error || `上报失败（HTTP ${response.status}）`);
        const parts = [
          payload.sessions !== undefined ? `会话 ${payload.sessions}` : null,
          payload.messages !== undefined ? `消息 ${payload.messages}` : null,
          payload.totalTokens !== undefined ? `Tokens ${payload.totalTokens}` : null,
        ].filter(Boolean);
        return `本次上报完成${parts.length ? `（${parts.join(' · ')}）` : '。'}`;
      })(),
    []
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  const telemetryEnabled = taskBus?.telemetry?.enabled === true;
  const collaborationEnabled = taskBus?.collaboration === true;

  return (
    <div>
      <SettingsSectionHeader title="Usage 监测" icon={<Clock size={12} />} />
      <div className="space-y-3 py-3">
        {/* 采集控制（与 CLI usage start/stop/report 等价） */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5"
          data-testid="usage-control-bar"
        >
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              telemetryEnabled
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'
            }`}
          >
            {telemetryEnabled ? '采集中' : '已停止'}
          </span>
          {telemetryEnabled ? (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runControl('stop', () => setTelemetryEnabled(false))}
              className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 text-[11px] text-[var(--color-text-secondary)] disabled:opacity-50"
            >
              {busyAction === 'stop' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Square size={11} />
              )}
              停止采集
            </button>
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runControl('start', () => setTelemetryEnabled(true))}
              className="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busyAction === 'start' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Play size={11} />
              )}
              开始采集
            </button>
          )}
          <button
            type="button"
            disabled={busyAction !== null || !telemetryEnabled}
            onClick={() => void runControl('scan', scanNow)}
            className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 text-[11px] text-[var(--color-text-secondary)] disabled:opacity-50"
            title={telemetryEnabled ? '立即扫描并上报一次' : '开始采集后可用'}
          >
            {busyAction === 'scan' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Upload size={11} />
            )}
            立即上报
          </button>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
            <UsersRound size={12} className="text-[var(--color-text-muted)]" />
            团队协作
            <input
              type="checkbox"
              checked={collaborationEnabled}
              disabled={busyAction !== null || taskBus === null}
              onChange={(event) =>
                void runControl('collaboration', () => setCollaboration(event.target.checked))
              }
              className="size-3.5 accent-[var(--color-accent)]"
            />
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {collaborationEnabled ? '已启用' : '已停用'}
            </span>
          </label>
        </div>
        {outcome ? <UsageControlOutcomeLine outcome={outcome} /> : null}

        {telemetryStatus ? (
          <UsageDashboard status={telemetryStatus} />
        ) : (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 text-xs text-[var(--color-text-muted)]">
            Usage 监测概览加载中。
          </div>
        )}
      </div>
    </div>
  );
};

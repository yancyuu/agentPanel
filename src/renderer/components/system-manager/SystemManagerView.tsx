import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { markdownComponents } from '@renderer/components/chat/markdownComponents';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import {
  Activity,
  BrainCircuit,
  ClipboardCheck,
  ScanLine,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import remarkGfm from 'remark-gfm';

import type {
  CleanupExecutionResult,
  CleanupScanResult,
  PiRuntimeStatus,
  SystemDiagnosticRun,
  SystemManagerStatus,
} from '@shared/types/systemManager';
import type { ComponentType } from 'react';

interface SystemManagerViewProps {
  isPaneFocused?: boolean;
  isActive?: boolean;
}

interface DiagnosticAction {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  prompt: string;
}

const READ_ONLY_BOUNDARY =
  '全程只读，不要删除、移动、修改、提交、推送、发布或部署；不要输出 token、cookie、私钥或完整敏感路径。';

const ALL_AGENT_FOLDERS_SCOPE = `必须覆盖所有已管理且未删除的数字员工，不能抽样。先通过 AgentCLI 团队清单和 ~/.hermit/teams/*/team.json 建立员工清单，再为每个员工解析：
- 团队存储目录 ~/.hermit/teams/{team-slug}
- team.json/config 中的 projectPath 或 workDir
- 成员自己的 cwd 或绑定工作目录

上述实际目录都要扫描。无法访问的员工必须单独列出原因。`;

const FULL_SCAN_ACTION: DiagnosticAction = {
  id: 'full-scan',
  title: '全盘扫描',
  description: '核心健康检查：员工是否在线、任务是否积压、交付是否待审。',
  icon: ScanLine,
  // 默认收窄到核心健康检查项，避免在慢运行时（多扩展 pi + 远端模型）上超时；
  // 记忆漂移 / 临时文件等大范围项走下方「常用扫描」按需单项执行。
  prompt: `请执行一次 AgentCLI 核心健康检查，并用普通用户能理解的中文输出结果。

只检查三项，不要扩展范围：
1. 每个数字员工的运行状态：团队目录与工作目录是否可访问、运行时是否在线；不可访问的列出原因。
2. 全局任务积压：长期无进展、等待用户补充、无人负责、交付后待审核过久的任务。
3. Workbench、内置 AgentCLI、任务总线、运行时和外部连接是否可用。

先通过 AgentCLI 团队清单和 ~/.hermit/teams/*/team.json 建立员工清单，再逐项给出“正常 / 需关注 / 建议处理”三组汇总；每条说明发生了什么和用户下一步应点哪里。不要逐字读取员工文档内容，不要读取或输出敏感正文。${READ_ONLY_BOUNDARY}`,
};

const QUICK_DIAGNOSTICS: readonly DiagnosticAction[] = [
  {
    id: 'memory-drift',
    title: '团队记忆漂移',
    description: '检查成员记忆、角色和协作规则是否冲突或过期。',
    icon: BrainCircuit,
    prompt: `请只读扫描所有已管理团队和数字员工的记忆漂移。

${ALL_AGENT_FOLDERS_SCOPE}

对比每个成员实际目录中的 CLAUDE.md、AGENTS.md、角色说明、团队协作指令和当前 AgentCLI 任务协议，找出重复、互相矛盾、过期路径、旧品牌说明和成员之间不一致的规则。输出员工总数、已扫描数、跳过项及原因，并按团队和成员列出风险等级、证据类型与建议保留的唯一事实来源。不要读取或输出敏感正文。${READ_ONLY_BOUNDARY}`,
  },
  {
    id: 'folder-hygiene',
    title: '临时文件扫描',
    description: '找出过多日志、截图、旧报告和陈旧工作区。',
    icon: Trash2,
    prompt: `请执行只读的临时文件与目录整洁扫描。

${ALL_AGENT_FOLDERS_SCOPE}

逐个员工目录检查是否存在过多临时文件、日志、截图、缓存、重复报告、陈旧构建产物、脏 worktree 或长期未使用的 agent workspace。输出员工总数、已扫描数、跳过项及原因；只列出可安全清理候选、占用或数量级、风险和需要人工确认的项目，不要实际删除。${READ_ONLY_BOUNDARY}`,
  },
  {
    id: 'runtime-health',
    title: '运行环境检查',
    description: '检查 Workbench、AgentCLI、运行时和外部连接。',
    icon: Activity,
    prompt: `请执行 AgentCLI 运行环境只读检查。

检查 Workbench 当前地址、内置 AgentCLI、任务总线、Claude CLI、hermit-bridge 兼容 sidecar、所有数字员工的运行目录和外部渠道连接是否可用。不要要求用户全局安装旧 openhermit/hermit，不要修改 Shell PATH。用“正常 / 异常 / 下一步”输出。${READ_ONLY_BOUNDARY}`,
  },
  {
    id: 'task-health',
    title: '任务积压检查',
    description: '查找卡住、无人负责、待回复和待审核任务。',
    icon: ClipboardCheck,
    prompt: `请只读检查 AgentCLI 全局任务状态。

找出长期无进展、无人负责、等待用户补充、等待负责人回复、交付后待审核过久以及状态可能不一致的任务。不要修改任务，只按优先级列出发生了什么、负责人和建议的下一步。${READ_ONLY_BOUNDARY}`,
  },
];

const ALL_DIAGNOSTIC_ACTIONS = [FULL_SCAN_ACTION, ...QUICK_DIAGNOSTICS];

function diagnosticActionById(actionId: string | undefined): DiagnosticAction | null {
  return ALL_DIAGNOSTIC_ACTIONS.find((action) => action.id === actionId) ?? null;
}

async function requestCleanup<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? payload.error || '清理请求失败'
        : '清理请求失败';
    throw new Error(message);
  }
  return payload as T;
}

async function requestDiagnosticRun(
  url: string,
  init?: RequestInit
): Promise<SystemDiagnosticRun | null> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as SystemDiagnosticRun | { error?: string } | null;
  if (!response.ok) {
    throw new Error(
      payload && 'error' in payload ? payload.error || '诊断请求失败' : '诊断请求失败'
    );
  }
  return payload && 'id' in payload ? payload : null;
}

function formatPathForTitle(pathValue: string): string {
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined;
  if (home && pathValue.startsWith(home)) return `~${pathValue.slice(home.length)}`;
  return pathValue;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const SystemManagerView = ({
  isPaneFocused: _isPaneFocused = false,
  isActive: _isActive = true,
}: SystemManagerViewProps): React.JSX.Element => {
  const [status, setStatus] = useState<SystemManagerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [scanRun, setScanRun] = useState<SystemDiagnosticRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleanupScan, setCleanupScan] = useState<CleanupScanResult | null>(null);
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<Set<string>>(new Set());
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);
  const [piRuntime, setPiRuntime] = useState<PiRuntimeStatus | null>(null);
  const openSettingsTab = useStore((state) => state.openSettingsTab);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await api.teams.ensureSystemManager();
      const [nextStatus, currentRun] = await Promise.all([
        api.systemManager.getStatus(),
        requestDiagnosticRun('/api/system-manager/diagnostics/current'),
      ]);
      setStatus(nextStatus);
      setScanRun(currentRun);
      void api.systemManager
        .getDiagnosticsRuntime()
        .then(setPiRuntime)
        .catch(() => setPiRuntime(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scanPending = scanRun?.status === 'running';
  const piUnavailable = piRuntime !== null && !piRuntime.available;
  const currentAction = diagnosticActionById(scanRun?.actionId);
  const latestResultText = scanRun?.result?.trim() ?? '';

  useEffect(() => {
    if (!scanPending) return;
    const timer = window.setInterval(() => {
      void requestDiagnosticRun('/api/system-manager/diagnostics/current')
        .then(setScanRun)
        .catch((pollError: unknown) =>
          setRunError(pollError instanceof Error ? pollError.message : '读取诊断进度失败')
        );
    }, 2500);
    return () => window.clearInterval(timer);
  }, [scanPending]);

  const runDiagnostic = useCallback(
    async (action: DiagnosticAction): Promise<void> => {
      if (loading || runningActionId || scanPending || status?.localStatus !== 'ready') return;
      if (piRuntime && !piRuntime.available) return;
      setRunningActionId(action.id);
      setRunError(null);
      try {
        const run = await requestDiagnosticRun('/api/system-manager/diagnostics/run', {
          method: 'POST',
          body: JSON.stringify({
            actionId: action.id,
            title: action.title,
            prompt: action.prompt,
          }),
        });
        setScanRun(run);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : '扫描启动失败，请稍后重试。');
        // 启动失败时强制重测一次 Pi 运行时（可能是配置刚被移除）
        void api.systemManager
          .getDiagnosticsRuntime(true)
          .then(setPiRuntime)
          .catch(() => undefined);
      } finally {
        setRunningActionId(null);
      }
    },
    [loading, runningActionId, scanPending, status?.localStatus]
  );

  const scanCleanupCandidates = useCallback(async (): Promise<void> => {
    if (loading || runningActionId || scanPending) return;
    setRunningActionId('folder-hygiene');
    setRunError(null);
    setCleanupNotice(null);
    try {
      const result = await requestCleanup<CleanupScanResult>('/api/system-manager/cleanup/scan');
      setCleanupScan(result);
      setSelectedCleanupIds(new Set(result.candidates.map((candidate) => candidate.id)));
    } catch (scanError) {
      setRunError(scanError instanceof Error ? scanError.message : '临时文件扫描失败');
    } finally {
      setRunningActionId(null);
    }
  }, [loading, runningActionId, scanPending]);

  const cleanSelectedCandidates = useCallback(async (): Promise<void> => {
    if (selectedCleanupIds.size === 0 || runningActionId) return;
    setRunningActionId('cleanup');
    setRunError(null);
    setCleanupNotice(null);
    try {
      const result = await requestCleanup<CleanupExecutionResult>('/api/system-manager/cleanup', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selectedCleanupIds] }),
      });
      setCleanupScan(result.remaining);
      setSelectedCleanupIds(new Set(result.remaining.candidates.map((candidate) => candidate.id)));
      setCleanupNotice(
        result.failed.length > 0
          ? `已清理 ${result.removedIds.length} 项，${result.failed.length} 项未能清理。`
          : `已清理 ${result.removedIds.length} 项，释放 ${formatBytes(result.freedBytes)}。`
      );
    } catch (cleanupError) {
      setRunError(cleanupError instanceof Error ? cleanupError.message : '清理失败');
    } finally {
      setRunningActionId(null);
    }
  }, [runningActionId, selectedCleanupIds]);

  const localReady = status?.localStatus === 'ready';
  const selectedCleanupCandidates =
    cleanupScan?.candidates.filter((candidate) => selectedCleanupIds.has(candidate.id)) ?? [];
  const selectedCleanupBytes = selectedCleanupCandidates.reduce(
    (sum, candidate) => sum + candidate.sizeBytes,
    0
  );
  const allCleanupSelected =
    Boolean(cleanupScan?.candidates.length) &&
    selectedCleanupIds.size === cleanupScan?.candidates.length;
  const scanStatusLabel = loading
    ? '正在准备'
    : error
      ? '暂时不可用'
      : scanPending
        ? `正在扫描${currentAction ? ` · ${currentAction.title}` : ''}`
        : cleanupScan
          ? `找到 ${cleanupScan.candidates.length} 项可安全清理内容`
          : latestResultText
            ? '扫描完成'
            : scanRun?.status === 'failed'
              ? '扫描失败，可以重新开始'
              : '可以开始扫描';

  return (
    <div className="flex size-full min-w-0 flex-col overflow-hidden bg-page-canvas text-[var(--color-text)]">
      <WorkbenchPageHeader
        title="诊断"
        description="一键检查数字员工和工作区，有问题再处理。"
        actions={
          loading || localReady ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              {loading ? '正在连接' : '诊断可用'}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
            >
              诊断异常 · 重新检测
            </button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <section className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--color-surface)] shadow-sm">
            <div className="grid items-center gap-6 px-5 py-7 sm:px-8 md:grid-cols-[220px_minmax(0,1fr)]">
              <div className="flex justify-center">
                <div className="relative flex size-44 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/10 via-sky-500/5 to-indigo-500/10">
                  <div
                    className={cn(
                      'absolute inset-2 rounded-full border border-emerald-400/25 border-t-emerald-500',
                      scanPending && 'animate-spin'
                    )}
                  />
                  <div className="absolute inset-6 rounded-full border border-[var(--surface-border)] bg-[var(--color-surface-raised)] shadow-inner" />
                  <div className="relative flex flex-col items-center gap-2 text-center">
                    <ShieldCheck
                      size={38}
                      className={cn(
                        scanPending
                          ? 'text-sky-500'
                          : localReady
                            ? 'text-emerald-500'
                            : 'text-amber-500'
                      )}
                    />
                    <span className="text-sm font-semibold text-[var(--color-text)]">
                      {scanPending
                        ? '扫描中'
                        : cleanupScan || latestResultText
                          ? '扫描完成'
                          : localReady
                            ? '准备就绪'
                            : '需要检查'}
                    </span>
                    <span className="max-w-24 text-[10px] leading-4 text-[var(--color-text-muted)]">
                      {scanStatusLabel}
                    </span>
                  </div>
                </div>
              </div>

              <div className="min-w-0 text-center md:text-left">
                <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  AgentCLI 安全体检
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">
                  点击一次，检查所有数字员工
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--color-text-muted)]">
                  自动遍历每个数字员工的团队目录、实际工作目录和成员目录，检查记忆漂移、临时文件、运行环境和任务积压。
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3 md:justify-start">
                  <Button
                    className="h-10 rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-500"
                    disabled={
                      !localReady ||
                      loading ||
                      Boolean(runningActionId) ||
                      scanPending ||
                      piUnavailable
                    }
                    onClick={() => void runDiagnostic(FULL_SCAN_ACTION)}
                  >
                    <ScanLine size={16} className={scanPending ? 'animate-pulse' : undefined} />
                    {scanPending ? '正在扫描…' : '开始全盘扫描'}
                  </Button>
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    起点：{formatPathForTitle(status?.adminWorkDir ?? '~/.hermit')}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {piRuntime && !piRuntime.available ? (
            <div
              role="alert"
              data-testid="pi-runtime-missing"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300"
            >
              <span className="min-w-0 flex-1">
                需先配置 Pi 运行时：{piRuntime.missing.join('；') || '运行时不可用'}
                。诊断由 Pi 执行，配置完成后即可开始扫描。
              </span>
              <button
                type="button"
                onClick={() => openSettingsTab('harness')}
                className="shrink-0 rounded-md border border-amber-500/30 px-2.5 py-1.5 font-medium transition-colors hover:bg-amber-500/10"
              >
                去配置
              </button>
            </div>
          ) : null}

          {(error || runError || scanRun?.error) && (
            <div
              role="alert"
              className="rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-3 text-xs text-red-500"
            >
              {runError ?? scanRun?.error ?? error}
            </div>
          )}

          <section aria-labelledby="quick-diagnostics-title">
            <div className="mb-3">
              <h2
                id="quick-diagnostics-title"
                className="text-sm font-semibold text-[var(--color-text)]"
              >
                常用扫描
              </h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                哪里不放心，就点哪里检查。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {QUICK_DIAGNOSTICS.map((action) => {
                const Icon = action.icon;
                const active = scanRun?.actionId === action.id && scanPending;
                return (
                  <button
                    key={action.id}
                    type="button"
                    disabled={
                      !localReady ||
                      loading ||
                      Boolean(runningActionId) ||
                      scanPending ||
                      piUnavailable
                    }
                    onClick={() =>
                      void (action.id === 'folder-hygiene'
                        ? scanCleanupCandidates()
                        : runDiagnostic(action))
                    }
                    className="group min-h-36 rounded-xl border border-[var(--surface-border)] bg-[var(--color-surface)] p-4 text-left transition-all hover:-translate-y-0.5 hover:border-emerald-500/35 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:shadow-none"
                  >
                    <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 transition-colors group-hover:bg-emerald-500/15 dark:text-emerald-400">
                      <Icon size={18} className={active ? 'animate-pulse' : undefined} />
                    </span>
                    <span className="mt-4 block text-sm font-medium text-[var(--color-text)]">
                      {action.title}
                    </span>
                    <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">
                      {runningActionId === action.id
                        ? '正在扫描所有数字员工目录…'
                        : action.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            aria-labelledby="diagnostic-result-title"
            className="overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--color-surface)]"
          >
            <div className="flex items-center gap-3 border-b border-[var(--surface-border)] px-4 py-3">
              <span className="flex size-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                <Activity size={16} />
              </span>
              <div className="min-w-0">
                <h2
                  id="diagnostic-result-title"
                  className="text-sm font-medium text-[var(--color-text)]"
                >
                  扫描结果
                </h2>
                <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                  {runningActionId === 'folder-hygiene'
                    ? '正在统计可安全清理的文件和目录'
                    : cleanupScan
                      ? `临时文件扫描 · ${cleanupScan.candidates.length} 项候选`
                      : scanPending
                        ? `正在检查所有数字员工目录 · ${currentAction?.title ?? scanRun?.title ?? '扫描'}`
                        : scanRun
                          ? `最近扫描：${currentAction?.title ?? scanRun.title}`
                          : '扫描完成后，结果会直接显示在这里。'}
                </p>
              </div>
            </div>

            <div className="min-h-48 p-5 sm:px-6">
              {cleanupScan ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--color-surface-raised)] px-4 py-3">
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={allCleanupSelected}
                        onChange={(event) =>
                          setSelectedCleanupIds(
                            event.target.checked
                              ? new Set(cleanupScan.candidates.map((candidate) => candidate.id))
                              : new Set()
                          )
                        }
                        className="size-4 rounded border-[var(--surface-border)] accent-emerald-600"
                      />
                      全选 {cleanupScan.candidates.length} 项
                    </label>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-[var(--color-text-muted)]">
                        已选 {selectedCleanupCandidates.length} 项 ·{' '}
                        {formatBytes(selectedCleanupBytes)}
                      </span>
                      <Button
                        className="h-9 bg-emerald-600 px-4 text-white hover:bg-emerald-500"
                        disabled={selectedCleanupIds.size === 0 || runningActionId === 'cleanup'}
                        onClick={() => void cleanSelectedCandidates()}
                      >
                        <Trash2 size={15} />
                        {runningActionId === 'cleanup' ? '正在清理…' : '清理选中项'}
                      </Button>
                    </div>
                  </div>

                  {cleanupNotice ? (
                    <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                      {cleanupNotice}
                    </p>
                  ) : null}

                  {cleanupScan.candidates.length === 0 ? (
                    <div className="py-10 text-center">
                      <ShieldCheck size={30} className="mx-auto text-emerald-500" />
                      <p className="mt-3 text-sm font-medium text-[var(--color-text)]">
                        当前没有需要清理的项目
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                        缓存、旧日志和 AgentCLI 临时目录都很整洁。
                      </p>
                    </div>
                  ) : (
                    [...new Set(cleanupScan.candidates.map((candidate) => candidate.category))].map(
                      (category) => {
                        const items = cleanupScan.candidates.filter(
                          (candidate) => candidate.category === category
                        );
                        return (
                          <div
                            key={category}
                            className="overflow-hidden rounded-xl border border-[var(--surface-border)]"
                          >
                            <div className="flex items-center justify-between bg-[var(--color-surface-raised)] px-4 py-2.5">
                              <span className="text-xs font-semibold text-[var(--color-text)]">
                                {items[0]?.categoryLabel}
                              </span>
                              <span className="text-[11px] text-[var(--color-text-muted)]">
                                {items.length} 项 ·{' '}
                                {formatBytes(items.reduce((sum, item) => sum + item.sizeBytes, 0))}
                              </span>
                            </div>
                            <div className="divide-y divide-[var(--surface-border)]">
                              {items.map((candidate) => (
                                <div
                                  key={candidate.id}
                                  className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--color-surface-raised)]"
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`选择清理 ${candidate.name}`}
                                    checked={selectedCleanupIds.has(candidate.id)}
                                    onChange={(event) =>
                                      setSelectedCleanupIds((current) => {
                                        const next = new Set(current);
                                        if (event.target.checked) next.add(candidate.id);
                                        else next.delete(candidate.id);
                                        return next;
                                      })
                                    }
                                    className="mt-0.5 size-4 rounded border-[var(--surface-border)] accent-emerald-600"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <span className="text-xs font-medium text-[var(--color-text)]">
                                        {candidate.name}
                                      </span>
                                      <span className="text-[11px] text-[var(--color-text-muted)]">
                                        {formatBytes(candidate.sizeBytes)} · {candidate.itemCount}{' '}
                                        个项目
                                      </span>
                                    </span>
                                    <span className="mt-1 block break-all text-[11px] text-[var(--color-text-muted)]">
                                      {candidate.displayPath}
                                    </span>
                                    <span className="mt-1 block text-[11px] text-[var(--color-text-secondary)]">
                                      {candidate.reason}
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      }
                    )
                  )}
                  <p className="text-[11px] leading-5 text-[var(--color-text-muted)]">
                    只会列出白名单中的缓存、旧日志和 AgentCLI 临时文件；不会清理项目源码、Git
                    数据、任务输入、正式成果、配置或未知目录。
                  </p>
                </div>
              ) : scanPending ? (
                <div
                  role="status"
                  className="flex min-h-36 flex-col items-center justify-center gap-3 text-center"
                >
                  <ScanLine size={28} className="animate-pulse text-sky-500" />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-text)]">数字员工正在检查</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                      会遍历全部数字员工的团队目录、实际工作目录和成员目录，完成后自动展示结果。
                    </p>
                  </div>
                </div>
              ) : latestResultText ? (
                <div className="prose prose-sm max-w-none text-[var(--color-text-secondary)] dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {latestResultText}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
                  <ShieldCheck size={28} className="opacity-35" />
                  <p className="text-sm">还没有扫描结果</p>
                  <p className="text-xs opacity-75">点击“开始全盘扫描”或上面的快捷扫描即可。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

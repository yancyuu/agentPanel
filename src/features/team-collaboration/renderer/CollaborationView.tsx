import { useCallback, useEffect, useMemo, useState } from 'react';

import { TaskInputPicker } from '@features/collaborative-workbench/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { getTaskInputMimeType, taskInputFileToBase64 } from '@renderer/utils/taskInputFiles';
import {
  Check,
  CheckCircle2,
  Circle,
  Crown,
  Loader2,
  Plus,
  RefreshCcw,
  Sparkles,
  Trash2,
  UserCheck,
  UsersRound,
  Wrench,
} from 'lucide-react';

import type {
  CollaborationRun,
  CollaborationRunPhase,
  CollaborationTeam,
  CollaborationTeamDetail,
  CreateCollaborationRunRequest,
} from '../shared/contracts';

interface ApiErrorPayload {
  error?: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as T & ApiErrorPayload;
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

async function serializeTaskInputFiles(
  files: File[]
): Promise<NonNullable<CreateCollaborationRunRequest['attachments']>> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mimeType: getTaskInputMimeType(file),
      base64Data: await taskInputFileToBase64(file),
    }))
  );
}

const phaseLabels: Record<CollaborationRunPhase, string> = {
  roundtable: '圆桌讨论中',
  electing: '正在推选队长',
  planning: '队长正在制定分工',
  executing: '团队正在执行',
  integrating: '队长正在整理结果',
  review: '请检查结果',
  completed: '已完成',
  failed: '协作遇到问题',
};

const phaseOrder = [
  'roundtable',
  'electing',
  'planning',
  'executing',
  'integrating',
  'review',
] as const satisfies readonly CollaborationRunPhase[];

const phaseStepLabels: Record<(typeof phaseOrder)[number], string> = {
  roundtable: '圆桌讨论',
  electing: '推选队长',
  planning: '制定分工',
  executing: '团队执行',
  integrating: '整理结果',
  review: '检查结果',
};

function phaseIndex(phase: CollaborationRunPhase): number {
  if (phase === 'completed') return phaseOrder.length;
  if (phase === 'failed') return -1;
  return phaseOrder.indexOf(phase);
}

/** 横向步骤条：圆点 + 连接线 + 下方标签（完成=实心 emerald，当前=indigo 脉动，未到=空心灰） */
function RunProgress({ run }: Readonly<{ run: CollaborationRun }>): React.JSX.Element {
  const currentIndex = phaseIndex(run.phase);
  return (
    <div className="overflow-x-auto pb-1" data-testid="run-stepper">
      <div className="flex min-w-max items-start">
        {phaseOrder.map((phase, index) => {
          const completed = currentIndex > index || run.phase === 'completed';
          const active = currentIndex === index;
          return (
            <div key={phase} className="flex items-start" data-testid="run-step">
              <div className="flex w-24 flex-col items-center gap-1.5">
                <span
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full',
                    completed
                      ? 'bg-emerald-500 text-white'
                      : active
                        ? 'bg-indigo-500 text-white'
                        : 'border border-[var(--color-border-emphasis)] text-transparent'
                  )}
                >
                  {completed ? (
                    <Check size={11} strokeWidth={3} />
                  ) : active ? (
                    <span className="size-1.5 animate-pulse rounded-full bg-white" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    'text-center text-[11px] leading-4',
                    completed
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : active
                        ? 'font-medium text-indigo-600 dark:text-indigo-300'
                        : 'text-[var(--color-text-muted)]'
                  )}
                >
                  {phaseStepLabels[phase]}
                </span>
              </div>
              {index < phaseOrder.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    'mt-2.5 h-px w-8 shrink-0',
                    currentIndex > index || run.phase === 'completed'
                      ? 'bg-emerald-500/50'
                      : 'bg-[var(--color-border)]'
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionTitle({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </h3>
  );
}

function RunDetail({
  run,
  onRetry,
  retrying,
}: Readonly<{
  run: CollaborationRun;
  onRetry(): void;
  retrying: boolean;
}>): React.JSX.Element {
  const captain = run.members.find((member) => member.teamSlug === run.captainTeamSlug);
  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <span>#{run.id.slice(0, 10)}</span>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium',
                  run.phase === 'failed'
                    ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300'
                    : run.phase === 'review' || run.phase === 'completed'
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                )}
              >
                {phaseLabels[run.phase]}
              </span>
            </div>
            <h2 className="text-xl font-semibold text-[var(--color-text)]">{run.title}</h2>
            {run.description ? (
              <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--color-text-secondary)]">
                {run.description}
              </p>
            ) : null}
          </div>
          {run.phase === 'failed' ? (
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <RefreshCcw size={13} className={retrying ? 'animate-spin' : undefined} />
              重新继续
            </button>
          ) : null}
        </div>
      </div>

      <RunProgress run={run} />

      {run.error ? (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          {run.error}
        </div>
      ) : null}

      {run.inputFiles && run.inputFiles.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--color-text-muted)]">任务输入：</span>
          {run.inputFiles.map((file) => (
            <span
              key={file.filename}
              className="rounded-full bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]"
            >
              {file.filename}
            </span>
          ))}
        </div>
      ) : null}

      {/* 圆桌讨论：竖向时间线，头像落在节点上 */}
      <section className="border-t border-[var(--surface-border-subtle)] pt-6">
        <SectionTitle>圆桌讨论</SectionTitle>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          成员按时间顺序发言并提名本任务队长。
        </p>
        <div className="mt-4">
          {run.ballots.map((ballot, index) => {
            const nominee = run.members.find(
              (member) => member.teamSlug === ballot.nomineeTeamSlug
            );
            const isLast = index === run.ballots.length - 1;
            return (
              <div key={ballot.memberTeamSlug} className="relative flex gap-3">
                <div className="flex w-9 shrink-0 flex-col items-center">
                  <img
                    src={agentAvatarUrl(ballot.memberDisplayName, 36)}
                    alt=""
                    className="z-10 size-9 shrink-0 rounded-full bg-[var(--color-surface-raised)] ring-4 ring-[var(--color-page-canvas,var(--color-surface))]"
                  />
                  {!isLast ? (
                    <span aria-hidden className="w-px flex-1 bg-[var(--color-border)]" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 pb-5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-[var(--color-text)]">
                      {ballot.memberDisplayName}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                      <UserCheck size={11} />
                      提名 {nominee?.displayName ?? ballot.nomineeTeamSlug}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
                    {ballot.statement}
                  </p>
                  <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                    <Wrench size={11} />
                    建议承担：{ballot.suggestedContribution}
                  </p>
                </div>
              </div>
            );
          })}
          {run.ballots.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--color-text-muted)]">
              <Loader2 size={15} className="animate-spin" />
              等待成员依次提交圆桌意见……
            </div>
          ) : null}
        </div>
      </section>

      {captain ? (
        <section className="flex items-center gap-3 rounded-xl bg-amber-500/[0.08] px-4 py-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300">
            <Crown size={19} />
          </span>
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">本任务队长</p>
            <p className="text-sm font-semibold text-[var(--color-text)]">{captain.displayName}</p>
          </div>
          <span className="ml-auto text-xs text-[var(--color-text-muted)]">由团队成员投票产生</span>
        </section>
      ) : null}

      {run.workItems.length > 0 ? (
        <section className="border-t border-[var(--surface-border-subtle)] pt-6">
          <SectionTitle>团队分工</SectionTitle>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            成员成果完成后，由队长统一整理交付。
          </p>
          <div className="mt-4 space-y-3">
            {run.workItems.map((item) => (
              <div
                key={item.id}
                className={cn(
                  'border-l-2 py-0.5 pl-3',
                  item.status === 'completed'
                    ? 'border-emerald-500'
                    : item.status === 'failed'
                      ? 'border-rose-500'
                      : 'border-indigo-500'
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {item.status === 'completed' ? (
                    <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
                  ) : item.status === 'running' || item.status === 'dispatching' ? (
                    <Loader2 size={14} className="shrink-0 animate-spin text-indigo-500" />
                  ) : item.status === 'failed' ? (
                    <Circle size={14} className="shrink-0 text-rose-500" />
                  ) : (
                    <Circle size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                  )}
                  <span className="text-sm font-medium text-[var(--color-text)]">{item.title}</span>
                  <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
                    {item.assigneeDisplayName}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  {item.description}
                </p>
                {item.error ? <p className="mt-1 text-xs text-rose-500">{item.error}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {run.finalResult ? (
        <section className="overflow-hidden rounded-xl bg-emerald-500/[0.06]">
          <div className="flex items-center justify-between px-4 pt-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
                <Sparkles size={16} className="text-emerald-500" />
                队长统一交付
              </h3>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                最终结果已进入收件箱，可以满意归档或提出修改。
              </p>
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto px-5 py-4">
            <MarkdownViewer content={run.finalResult} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function CollaborationView(): React.JSX.Element {
  const digitalTeams = useStore((state) => state.teams);
  const fetchTeams = useCallback(() => useStore.getState().fetchTeams(), []);
  const openInboxTab = useCallback(() => useStore.getState().openInboxTab(), []);
  const [teams, setTeams] = useState<CollaborationTeam[]>([]);
  const [selectedTeamSlug, setSelectedTeamSlug] = useState('');
  const [detail, setDetail] = useState<CollaborationTeamDetail | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamDescription, setTeamDescription] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskInputFiles, setTaskInputFiles] = useState<File[]>([]);
  const [taskComposerOpen, setTaskComposerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableDigitalTeams = useMemo(
    () =>
      digitalTeams
        .filter(
          (team) => !team.deletedAt && !team.pendingDelete && team.teamName !== 'system-manager'
        )
        .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN')),
    [digitalTeams]
  );

  const loadTeams = useCallback(async () => {
    const payload = await requestJson<CollaborationTeam[]>('/api/collaboration/teams');
    setTeams(payload);
    if (!selectedTeamSlug && payload[0]) setSelectedTeamSlug(payload[0].slug);
  }, [selectedTeamSlug]);

  const loadDetail = useCallback(async (teamSlug: string) => {
    const payload = await requestJson<CollaborationTeamDetail>(
      `/api/collaboration/teams/${encodeURIComponent(teamSlug)}`
    );
    setDetail(payload);
    setSelectedRunId((current) =>
      payload.runs.some((run) => run.id === current) ? current : (payload.runs[0]?.id ?? '')
    );
  }, []);

  useEffect(() => {
    void fetchTeams();
    void loadTeams().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : '加载小队失败')
    );
  }, [fetchTeams, loadTeams]);

  useEffect(() => {
    if (!selectedTeamSlug) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedTeamSlug).catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : '加载团队详情失败')
    );
  }, [loadDetail, selectedTeamSlug]);

  const selectedRun = detail?.runs.find((run) => run.id === selectedRunId) ?? null;
  const shouldPoll = selectedRun && !['review', 'completed'].includes(selectedRun.phase);

  useEffect(() => {
    if (!selectedTeamSlug || !shouldPoll) return;
    const timer = window.setInterval(() => {
      void loadDetail(selectedTeamSlug).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loadDetail, selectedTeamSlug, shouldPoll]);

  const toggleSelectedMember = useCallback((memberTeamName: string) => {
    setSelectedMembers((current) =>
      current.includes(memberTeamName)
        ? current.filter((value) => value !== memberTeamName)
        : [...current, memberTeamName]
    );
  }, []);

  const createTeam = async (): Promise<void> => {
    if (!teamName.trim() || selectedMembers.length < 2 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const team = await requestJson<CollaborationTeam>('/api/collaboration/teams', {
        method: 'POST',
        body: JSON.stringify({
          displayName: teamName.trim(),
          description: teamDescription.trim() || undefined,
          memberTeamSlugs: selectedMembers,
        }),
      });
      setTeamName('');
      setTeamDescription('');
      setSelectedMembers([]);
      setCreatingTeam(false);
      await loadTeams();
      setSelectedTeamSlug(team.slug);
      await loadDetail(team.slug);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建小队失败');
    } finally {
      setSubmitting(false);
    }
  };

  const createRun = async (): Promise<void> => {
    if (!selectedTeamSlug || !taskTitle.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await requestJson<CollaborationRun>(
        `/api/collaboration/teams/${encodeURIComponent(selectedTeamSlug)}/runs`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: taskTitle.trim(),
            description: taskDescription.trim() || undefined,
            attachments: await serializeTaskInputFiles(taskInputFiles),
          }),
        }
      );
      setTaskTitle('');
      setTaskDescription('');
      setTaskInputFiles([]);
      setTaskComposerOpen(false);
      await loadDetail(selectedTeamSlug);
      setSelectedRunId(run.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建团队任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const retryRun = async (): Promise<void> => {
    if (!selectedRun || retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await requestJson(`/api/collaboration/runs/${encodeURIComponent(selectedRun.id)}/retry`, {
        method: 'POST',
      });
      await loadDetail(selectedTeamSlug);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '继续协作失败');
    } finally {
      setRetrying(false);
    }
  };

  const deleteTeam = async (): Promise<void> => {
    if (!selectedTeamSlug || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await requestJson(`/api/collaboration/teams/${encodeURIComponent(selectedTeamSlug)}`, {
        method: 'DELETE',
      });
      setDeleteConfirmOpen(false);
      setDetail(null);
      setSelectedRunId('');
      setSelectedTeamSlug('');
      await loadTeams();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除小队失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-page-canvas">
      {/* 顶部：标题 + 文字 tab 条 + 创建入口 */}
      <div className="shrink-0 border-b border-[var(--surface-border-subtle)]">
        <div className="flex items-end justify-between gap-4 px-5 pt-3">
          <div className="flex min-w-0 items-end gap-4">
            <div className="pb-1.5">
              <h1 className="text-sm font-semibold text-[var(--color-text)]">小队</h1>
            </div>
            <nav aria-label="小队切换" className="flex min-w-0 items-end gap-1 overflow-x-auto">
              {teams.map((team) => {
                const selected = selectedTeamSlug === team.slug && !creatingTeam;
                return (
                  <button
                    key={team.slug}
                    type="button"
                    onClick={() => {
                      setSelectedTeamSlug(team.slug);
                      setCreatingTeam(false);
                      setError(null);
                    }}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'shrink-0 border-b-2 px-3 pb-1.5 pt-1 text-sm transition-colors',
                      selected
                        ? 'border-indigo-500 font-medium text-[var(--color-text)]'
                        : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                    )}
                  >
                    <span className="whitespace-nowrap">{team.displayName}</span>
                    <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
                      {team.memberTeamSlugs.length}
                    </span>
                  </button>
                );
              })}
              {teams.length === 0 && !creatingTeam ? (
                <span className="px-3 pb-1.5 text-sm text-[var(--color-text-muted)]">
                  还没有小队
                </span>
              ) : null}
            </nav>
          </div>
          <button
            type="button"
            onClick={() => setCreatingTeam(true)}
            className="mb-1 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            <Plus size={13} />
            创建小队
          </button>
        </div>
      </div>

      <main className="min-h-0 overflow-y-auto">
        {error ? (
          <div className="mx-6 mt-5 rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        {creatingTeam ? (
          <div className="mx-auto max-w-4xl px-8 py-8">
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-[var(--color-text)]">创建小队</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                选择至少两名智能体。收到任务后，他们会先开圆桌并自己选出本任务队长。
              </p>
            </div>
            <div className="space-y-5">
              <label className="block">
                <span className="text-xs text-[var(--color-text-muted)]">小队名称</span>
                <input
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="例如：跨境电商调研组"
                  className="mt-2 h-10 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm outline-none focus:border-indigo-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-[var(--color-text-muted)]">小队擅长什么（可选）</span>
                <textarea
                  value={teamDescription}
                  onChange={(event) => setTeamDescription(event.target.value)}
                  placeholder="例如：市场调研、数据分析和报告交付"
                  className="mt-2 min-h-24 w-full rounded-md border border-[var(--color-border)] bg-transparent p-3 text-sm outline-none focus:border-indigo-500"
                />
              </label>
              <div>
                <p className="text-xs text-[var(--color-text-muted)]">选择成员</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {availableDigitalTeams.map((team) => {
                    const selected = selectedMembers.includes(team.teamName);
                    return (
                      <button
                        key={team.teamName}
                        type="button"
                        onClick={() => toggleSelectedMember(team.teamName)}
                        className={cn(
                          'flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors',
                          selected
                            ? 'bg-indigo-500/[0.08]'
                            : 'hover:bg-[var(--color-surface-hover)]'
                        )}
                      >
                        <img
                          src={agentAvatarUrl(team.displayName, 34)}
                          alt=""
                          className="size-8 rounded-full bg-[var(--color-surface-raised)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--color-text)]">
                            {team.displayName}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                            {team.description || team.teamName}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'flex size-5 items-center justify-center rounded-full',
                            selected
                              ? 'bg-indigo-600 text-white'
                              : 'border border-[var(--color-border)]'
                          )}
                        >
                          {selected ? <Check size={12} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-[var(--surface-border-subtle)] pt-4">
                <button
                  type="button"
                  onClick={() => setCreatingTeam(false)}
                  className="rounded-md px-3 py-2 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!teamName.trim() || selectedMembers.length < 2 || submitting}
                  onClick={() => void createTeam()}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  {submitting ? '正在创建…' : '创建小队'}
                </button>
              </div>
            </div>
          </div>
        ) : detail ? (
          <div className="w-full px-5 py-5 lg:px-6">
            <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-[var(--color-text)]">
                  {detail.team.displayName}
                </h2>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {detail.team.description || '成员会在每次任务开始前通过圆桌选出本任务队长。'}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {detail.members.map((member) => (
                    <span
                      key={member.teamSlug}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs',
                        member.deleted
                          ? 'text-[var(--color-text-muted)]'
                          : 'text-[var(--color-text-secondary)]'
                      )}
                    >
                      <img
                        src={agentAvatarUrl(member.displayName, 20)}
                        alt=""
                        className="size-4 rounded-full"
                      />
                      <span className={member.deleted ? 'line-through' : undefined}>
                        {member.displayName}
                      </span>
                      {member.deleted ? (
                        <span className="rounded bg-rose-500/10 px-1 text-[10px] font-medium text-rose-500">
                          已删除
                        </span>
                      ) : null}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label="删除小队"
                  title="删除小队"
                  className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs text-[var(--color-text-muted)] transition-colors hover:border-rose-500/30 hover:text-rose-500"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  onClick={openInboxTab}
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  打开交付收件箱
                </button>
                <button
                  type="button"
                  onClick={() => setTaskComposerOpen((open) => !open)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500"
                >
                  <Plus size={14} />
                  {taskComposerOpen ? '收起新任务' : '新建小队任务'}
                </button>
              </div>
            </header>

            <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
              <aside className="lg:sticky lg:top-5 lg:border-r lg:border-[var(--surface-border-subtle)] lg:pr-5">
                <div className="flex items-center justify-between px-1 pb-3">
                  <div>
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      小队任务
                    </h3>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {detail.runs.length} 项任务
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="新建小队任务"
                    onClick={() => setTaskComposerOpen(true)}
                    className="rounded-md p-1.5 text-indigo-500 hover:bg-indigo-500/10"
                  >
                    <Plus size={15} />
                  </button>
                </div>
                {detail.runs.length > 0 ? (
                  <div className="space-y-0.5">
                    {detail.runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setTaskComposerOpen(false);
                        }}
                        className={cn(
                          'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                          selectedRunId === run.id && !taskComposerOpen
                            ? 'bg-indigo-500/[0.08]'
                            : 'hover:bg-[var(--color-surface-hover)]'
                        )}
                      >
                        <span className="line-clamp-2 block text-sm font-medium text-[var(--color-text)]">
                          {run.title}
                        </span>
                        <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                          {phaseLabels[run.phase]}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
                    还没有任务
                  </div>
                )}
              </aside>

              <div className="min-w-0">
                {taskComposerOpen ? (
                  <section>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-[var(--color-text)]">
                          新建小队任务
                        </h3>
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          创建后自动进入圆桌讨论、队长选举、成员执行和最终整合。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTaskComposerOpen(false)}
                        className="rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
                      >
                        取消
                      </button>
                    </div>
                    <input
                      value={taskTitle}
                      onChange={(event) => setTaskTitle(event.target.value)}
                      placeholder="例如：调研亚马逊日本站开店流程、费用和风险"
                      className="h-10 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm outline-none focus:border-indigo-500"
                    />
                    <textarea
                      value={taskDescription}
                      onChange={(event) => setTaskDescription(event.target.value)}
                      placeholder="补充范围、目标、截止时间或希望收到的交付形式（可选）"
                      className="mt-2 min-h-24 w-full rounded-md border border-[var(--color-border)] bg-transparent p-3 text-sm outline-none focus:border-indigo-500"
                    />
                    <div className="mt-3">
                      <TaskInputPicker files={taskInputFiles} onChange={setTaskInputFiles} />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        disabled={!taskTitle.trim() || submitting}
                        onClick={() => void createRun()}
                        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                      >
                        <Sparkles size={14} />
                        {submitting ? '小队正在准备…' : '开始小队协作'}
                      </button>
                    </div>
                  </section>
                ) : selectedRun ? (
                  <RunDetail
                    run={selectedRun}
                    onRetry={() => void retryRun()}
                    retrying={retrying}
                  />
                ) : (
                  <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
                    <p className="text-sm font-medium text-[var(--color-text)]">还没有小队任务</p>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      新建任务后，这里会展示圆桌结论、成员分工和交付进度。
                    </p>
                    <button
                      type="button"
                      onClick={() => setTaskComposerOpen(true)}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      <Plus size={14} />
                      新建小队任务
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            选择或创建一个小队
          </div>
        )}
      </main>

      {deleteConfirmOpen && detail ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !deleting && setDeleteConfirmOpen(false)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[var(--color-text)]">删除小队</h3>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              确定删除小队「{detail.team.displayName}
              」吗？小队配置将被移除，历史任务记录保留在归档中。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteConfirmOpen(false)}
                className="rounded-md px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void deleteTeam()}
                className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : null}
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

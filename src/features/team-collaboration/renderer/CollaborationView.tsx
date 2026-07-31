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
  UsersRound,
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

const phaseOrder: CollaborationRunPhase[] = [
  'roundtable',
  'electing',
  'planning',
  'executing',
  'integrating',
  'review',
];

function phaseIndex(phase: CollaborationRunPhase): number {
  if (phase === 'completed') return phaseOrder.length;
  if (phase === 'failed') return -1;
  return phaseOrder.indexOf(phase);
}

function RunProgress({ run }: Readonly<{ run: CollaborationRun }>): React.JSX.Element {
  const currentIndex = phaseIndex(run.phase);
  return (
    <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
      {phaseOrder.map((phase, index) => {
        const completed = currentIndex > index || run.phase === 'completed';
        const active = currentIndex === index;
        return (
          <div
            key={phase}
            className={cn(
              'rounded-lg border px-3 py-2 text-xs',
              completed
                ? 'border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-700 dark:text-emerald-300'
                : active
                  ? 'border-indigo-500/25 bg-indigo-500/[0.06] text-indigo-700 dark:text-indigo-300'
                  : 'border-[var(--surface-border-subtle)] text-[var(--color-text-muted)]'
            )}
          >
            <span className="mb-1 flex items-center gap-1.5">
              {completed ? (
                <CheckCircle2 size={13} />
              ) : active ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Circle size={12} />
              )}
              {index + 1}
            </span>
            <span>{phaseLabels[phase]}</span>
          </div>
        );
      })}
    </div>
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
    <div className="space-y-5">
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
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-4 py-3">
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

      <section className="rounded-xl border border-[var(--surface-border-subtle)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--surface-border-subtle)] px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
            <UsersRound size={16} className="text-indigo-500" />
            圆桌讨论
          </h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            成员按时间顺序发言并提名本任务队长。
          </p>
        </div>
        <div className="divide-y divide-[var(--surface-border-subtle)]">
          {run.ballots.map((ballot) => {
            const nominee = run.members.find(
              (member) => member.teamSlug === ballot.nomineeTeamSlug
            );
            return (
              <div key={ballot.memberTeamSlug} className="flex gap-3 px-4 py-3">
                <img
                  src={agentAvatarUrl(ballot.memberDisplayName, 36)}
                  alt=""
                  className="size-9 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-text)]">
                      {ballot.memberDisplayName}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      提名 {nominee?.displayName ?? ballot.nomineeTeamSlug}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
                    {ballot.statement}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    建议承担：{ballot.suggestedContribution}
                  </p>
                </div>
              </div>
            );
          })}
          {run.ballots.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm text-[var(--color-text-muted)]">
              <Loader2 size={15} className="animate-spin" />
              等待成员依次提交圆桌意见……
            </div>
          ) : null}
        </div>
      </section>

      {captain ? (
        <section className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-4 py-3">
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
        <section className="rounded-xl border border-[var(--surface-border-subtle)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--surface-border-subtle)] px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">团队分工</h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              成员成果完成后，由队长统一整理交付。
            </p>
          </div>
          <div className="divide-y divide-[var(--surface-border-subtle)]">
            {run.workItems.map((item) => (
              <div key={item.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
                      item.status === 'completed'
                        ? 'bg-emerald-500/12 text-emerald-600'
                        : item.status === 'failed'
                          ? 'bg-rose-500/12 text-rose-600'
                          : 'bg-indigo-500/10 text-indigo-600'
                    )}
                  >
                    {item.status === 'completed' ? (
                      <Check size={13} />
                    ) : item.status === 'running' || item.status === 'dispatching' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Circle size={12} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--color-text)]">
                        {item.title}
                      </span>
                      <span className="rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
                        {item.assigneeDisplayName}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                      {item.description}
                    </p>
                    {item.error ? <p className="mt-1 text-xs text-rose-500">{item.error}</p> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {run.finalResult ? (
        <section className="overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03]">
          <div className="flex items-center justify-between border-b border-emerald-500/15 px-4 py-3">
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

  return (
    <div className="flex size-full min-h-0 flex-col bg-page-canvas">
      <aside className="flex shrink-0 items-stretch border-b border-[var(--surface-border-subtle)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--surface-border-subtle)] px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold text-[var(--color-text)]">小队</h1>
            <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              选成员，团队自己选队长并完成交付。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreatingTeam(true)}
            className="rounded-md p-2 text-indigo-600 hover:bg-indigo-500/10"
            aria-label="创建小队"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {teams.map((team) => (
            <button
              key={team.slug}
              type="button"
              onClick={() => {
                setSelectedTeamSlug(team.slug);
                setCreatingTeam(false);
                setError(null);
              }}
              className={cn(
                'min-w-52 shrink-0 border-l border-[var(--surface-border-subtle)] px-4 py-3 text-left',
                selectedTeamSlug === team.slug && !creatingTeam
                  ? 'bg-[var(--color-surface-selected)]'
                  : 'hover:bg-[var(--color-surface-hover)]'
              )}
            >
              <span className="flex items-center gap-2">
                <UsersRound size={16} className="text-indigo-500" />
                <span className="truncate text-sm font-medium text-[var(--color-text)]">
                  {team.displayName}
                </span>
              </span>
              <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                {team.memberTeamSlugs.length} 名智能体
              </span>
            </button>
          ))}
          {teams.length === 0 && !creatingTeam ? (
            <div className="flex items-center px-5 text-center text-sm text-[var(--color-text-muted)]">
              还没有小队
            </div>
          ) : null}
        </div>
      </aside>

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
            <div className="space-y-5 rounded-xl border border-[var(--surface-border-subtle)] bg-[var(--color-surface)] p-5">
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
                          'flex items-center gap-3 rounded-lg border px-3 py-3 text-left',
                          selected
                            ? 'border-indigo-500/40 bg-indigo-500/[0.06]'
                            : 'border-[var(--surface-border-subtle)] hover:bg-[var(--color-surface-hover)]'
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
                            'flex size-5 items-center justify-center rounded-full border',
                            selected
                              ? 'border-indigo-500 bg-indigo-600 text-white'
                              : 'border-[var(--color-border)]'
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
            <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-[var(--color-text)]">
                  {detail.team.displayName}
                </h2>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {detail.team.description || '成员会在每次任务开始前通过圆桌选出本任务队长。'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.members.map((member) => (
                    <span
                      key={member.teamSlug}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]"
                    >
                      <img
                        src={agentAvatarUrl(member.displayName, 20)}
                        alt=""
                        className="size-4 rounded-full"
                      />
                      {member.displayName}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
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

            <div className="grid items-start gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
              <aside className="rounded-xl border border-[var(--surface-border-subtle)] bg-[var(--color-surface)] p-3 lg:sticky lg:top-5">
                <div className="flex items-center justify-between px-1 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--color-text)]">小队任务</h3>
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
                  <div className="space-y-1.5">
                    {detail.runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setTaskComposerOpen(false);
                        }}
                        className={cn(
                          'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                          selectedRunId === run.id && !taskComposerOpen
                            ? 'border-indigo-500/30 bg-indigo-500/[0.06]'
                            : 'border-transparent hover:bg-[var(--color-surface-hover)]'
                        )}
                      >
                        <span className="line-clamp-2 block text-sm font-medium text-[var(--color-text)]">
                          {run.title}
                        </span>
                        <span className="mt-1.5 block text-[11px] text-[var(--color-text-muted)]">
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
                  <section className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.035] p-4">
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
                      className="h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm outline-none focus:border-indigo-500"
                    />
                    <textarea
                      value={taskDescription}
                      onChange={(event) => setTaskDescription(event.target.value)}
                      placeholder="补充范围、目标、截止时间或希望收到的交付形式（可选）"
                      className="mt-2 min-h-24 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm outline-none focus:border-indigo-500"
                    />
                    <div className="mt-3">
                      <TaskInputPicker files={taskInputFiles} onChange={setTaskInputFiles} />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        disabled={!taskTitle.trim() || submitting}
                        onClick={() => void createRun()}
                        className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
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
    </div>
  );
}

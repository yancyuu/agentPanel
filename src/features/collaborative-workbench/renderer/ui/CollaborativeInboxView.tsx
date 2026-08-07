import { useEffect, useMemo, useState } from 'react';

import { TaskDetailPanel } from '@renderer/components/team/dialogs/TaskDetailPanel';
import { useGlobalTaskDetailModel } from '@renderer/components/team/dialogs/useGlobalTaskDetailModel';
import { AgentTuningDialog } from '@renderer/components/team/members/AgentTuningDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { cn } from '@renderer/lib/utils';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { extractFilePathFromChangeKey } from '@renderer/utils/reviewKey';
import { getTaskInputMimeType, taskInputFileToBase64 } from '@renderer/utils/taskInputFiles';
import { getReviewStateFromTask } from '@shared/utils/reviewState';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  ListPlus,
  MessageSquare,
  Plus,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react';

import { useCollaborativeInbox } from '../hooks/useCollaborativeInbox';
import { useInboxTaskRecipients } from '../hooks/useInboxTaskRecipients';
import { useTaskWorkspaceNavigation } from '../hooks/useTaskWorkspaceNavigation';

import { InboxTaskList } from './InboxTaskList';
import { InboxTaskMessageList } from './InboxTaskMessageList';
import { TaskInputPicker } from './TaskInputPicker';
import { TaskReviewThread } from './TaskReviewThread';

import type { InboxTaskRecipientOption } from '../hooks/useInboxTaskRecipients';

type InboxMode = 'messages' | 'create' | 'tasks';
type CollaborativeInboxSurface = 'inbox' | 'tasks';

interface CollaborativeInboxViewProps {
  surface?: CollaborativeInboxSurface;
}

interface FollowUpSource {
  taskId: string;
  displayId: string;
  subject: string;
  teamName: string;
  ownerName: string;
}

function recipientKey(
  option: Pick<InboxTaskRecipientOption, 'kind' | 'teamName' | 'memberName'>
): string {
  return `${option.kind ?? 'agent'}\u0000${option.teamName}\u0000${option.memberName}`;
}

async function createSquadRun(
  collaborationTeamSlug: string,
  title: string,
  description: string | undefined,
  files: File[]
): Promise<void> {
  const attachments = await Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mimeType: getTaskInputMimeType(file),
      base64Data: await taskInputFileToBase64(file),
    }))
  );
  const response = await fetch(
    `/api/collaboration/teams/${encodeURIComponent(collaborationTeamSlug)}/runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    }
  );
  if (response.ok) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(payload.error || '小队任务创建失败，请稍后重试。');
}

export function CollaborativeInboxView({
  surface = 'inbox',
}: Readonly<CollaborativeInboxViewProps>): React.JSX.Element {
  const taskInbox = useCollaborativeInbox();
  const recipientInbox = useInboxTaskRecipients();
  const [mode, setMode] = useState<InboxMode>(surface === 'inbox' ? 'messages' : 'tasks');
  const { openTask } = useTaskWorkspaceNavigation();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [selectedRecipientKey, setSelectedRecipientKey] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [taskInputFiles, setTaskInputFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [followUpSource, setFollowUpSource] = useState<FollowUpSource | null>(null);
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
  const [followUpTitle, setFollowUpTitle] = useState('');
  const [followUpDescription, setFollowUpDescription] = useState('');
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [tuningOpen, setTuningOpen] = useState(false);
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const selectedTask = mode === 'messages' ? taskInbox.selectedMessage : taskInbox.selectedTask;
  const selectedRecipient = useMemo(
    () =>
      recipientInbox.recipientOptions.find(
        (option) => recipientKey(option) === selectedRecipientKey
      ) ?? null,
    [recipientInbox.recipientOptions, selectedRecipientKey]
  );
  const taskModel = useGlobalTaskDetailModel(
    selectedTask?.task.teamName ?? '',
    selectedTask?.task.id ?? ''
  );
  const selectedTaskOwnerMember = useMemo(() => {
    const owner = (taskModel.task ?? selectedTask?.task)?.owner?.trim();
    if (!owner) return null;
    return (
      taskModel.members.find((member) => member.name === owner || member.agentId === owner) ?? null
    );
  }, [selectedTask?.task, taskModel.members, taskModel.task]);
  const selectedTaskReviewState = (() => {
    const task = taskModel.task ?? selectedTask?.task;
    return task ? getReviewStateFromTask(task) : undefined;
  })();
  const selectedTaskRecipient = useMemo(() => {
    if (!selectedTask || !selectedTaskOwnerMember) return null;
    return (
      recipientInbox.recipientOptions.find(
        (option) =>
          option.teamName === selectedTask.task.teamName &&
          option.memberName === selectedTaskOwnerMember.name
      ) ?? null
    );
  }, [recipientInbox.recipientOptions, selectedTask, selectedTaskOwnerMember]);

  useEffect(() => {
    setMode(surface === 'inbox' ? 'messages' : 'tasks');
    setMobileDetailOpen(false);
    setFollowUpSource(null);
    setFollowUpDialogOpen(false);
    setTuningOpen(false);
    setApproveConfirmOpen(false);
    setReviewError(null);
  }, [surface]);

  useEffect(() => {
    if (selectedRecipient || recipientInbox.recipientOptions.length === 0) return;
    setSelectedRecipientKey(recipientKey(recipientInbox.recipientOptions[0]));
  }, [recipientInbox.recipientOptions, selectedRecipient]);

  useEffect(() => {
    if (!recipientInbox.navigationRequestAt || !recipientInbox.requestedRecipient) return;
    setSelectedRecipientKey(recipientKey(recipientInbox.requestedRecipient));
    setFollowUpSource(null);
    setSubject('');
    setDescription(recipientInbox.requestedRecipient.initialText?.trim() ?? '');
    setTaskInputFiles([]);
    setMode('create');
    setMobileDetailOpen(true);
  }, [recipientInbox.navigationRequestAt, recipientInbox.requestedRecipient]);

  useEffect(() => {
    if ((mode === 'messages' || mode === 'tasks') && !selectedTask) setMobileDetailOpen(false);
  }, [mode, selectedTask]);

  const submitTask = async (): Promise<void> => {
    if (!selectedRecipient || !subject.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const taskTitle = subject.trim();
      const taskDescription = description.trim() || undefined;
      if (selectedRecipient.kind === 'squad' && selectedRecipient.collaborationTeamSlug) {
        await createSquadRun(
          selectedRecipient.collaborationTeamSlug,
          taskTitle,
          taskDescription,
          taskInputFiles
        );
        setMode('tasks');
        taskInbox.refresh();
      } else {
        const createRequest = {
          subject: taskTitle,
          description: taskDescription,
          owner: selectedRecipient.memberName,
          startImmediately: true,
        };
        const task =
          taskInputFiles.length > 0
            ? await taskInbox.createTask(selectedRecipient.teamName, createRequest, taskInputFiles)
            : await taskInbox.createTask(selectedRecipient.teamName, createRequest);
        if (surface === 'tasks') {
          taskInbox.selectTask(`${selectedRecipient.teamName}:${task.id}`);
          setMode('tasks');
        } else {
          setMode('messages');
        }
      }
      setSubject('');
      setDescription('');
      setTaskInputFiles([]);
      setMobileDetailOpen(true);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '任务创建失败，请稍后重试。');
    } finally {
      setCreating(false);
    }
  };

  const detailTask = taskModel.task ?? selectedTask?.task ?? null;
  const openFeedbackItems = (detailTask?.feedbackItems ?? []).filter(
    (item) => item.status === 'open'
  );

  // 归档后的沉淀建议消息（task:<taskId> 线程中 source=precipitation_suggestion 的最新一条）
  const teamMessages =
    taskInbox.teamMessagesByName[selectedTask?.task.teamName ?? '']?.canonicalMessages;
  const { sendTeamMessage, setTaskNeedsClarification } = taskInbox;
  const precipitationSuggestion = useMemo(() => {
    if (!detailTask) return null;
    const conversationId = `task:${detailTask.id}`;
    const message = [...(teamMessages ?? [])]
      .reverse()
      .find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.source === 'precipitation_suggestion'
      );
    return message ? { text: message.text, at: message.timestamp } : null;
  }, [detailTask, teamMessages]);

  // 待你补充态突出展示的澄清问题：task:<taskId> 线程里最新一条 agent 消息
  const clarificationQuestion = useMemo(() => {
    if (detailTask?.needsClarification !== 'user') return null;
    const conversationId = `task:${detailTask.id}`;
    const message = [...(teamMessages ?? [])]
      .reverse()
      .find(
        (candidate) => candidate.conversationId === conversationId && candidate.from !== 'user'
      );
    return message ? { text: message.text, at: message.timestamp } : null;
  }, [detailTask, teamMessages]);

  // 补充说明/普通讨论提交：讨论消息进任务线程并派发 agent 会话（send-message），
  // 待你补充态同时清除澄清标记；不创建反馈条目、不改变评审状态
  const submitThreadDiscussion = async (text: string): Promise<void> => {
    if (!selectedTask || !detailTask) return;
    const teamName = selectedTask.task.teamName;
    const conversationId = `task:${detailTask.id}`;
    await sendTeamMessage(teamName, {
      member: detailTask.owner?.trim() || selectedTask.task.teamDisplayName || teamName,
      text,
      summary: text,
      conversationId,
      replyToConversationId: conversationId,
      taskRefs: [
        {
          taskId: detailTask.id,
          displayId: detailTask.displayId?.trim() || detailTask.id,
          teamName,
        },
      ],
      to: detailTask.owner?.trim() || undefined,
      source: 'user_sent',
    });
    if (detailTask.needsClarification === 'user') {
      await setTaskNeedsClarification(teamName, detailTask.id, null);
    }
    taskInbox.refresh();
  };

  const runApprove = async (force: boolean): Promise<void> => {
    if (!selectedTask || reviewSubmitting) return;
    setReviewSubmitting(true);
    setReviewError(null);
    try {
      await taskInbox.approveTask(selectedTask.task.teamName, selectedTask.task.id, force);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : '确认结果失败，请稍后重试。');
    } finally {
      setReviewSubmitting(false);
    }
  };

  // 有 open 反馈时先弹拦截确认（逐条列出），否则直接归档
  const approveCurrentTask = (): void => {
    setReviewError(null);
    if (openFeedbackItems.length > 0) {
      setApproveConfirmOpen(true);
      return;
    }
    void runApprove(false);
  };

  // 打开「新建后续任务」确认表单：预填标题和描述，确认后才创建并开工
  const startFollowUpTask = (): void => {
    if (!selectedTask || !selectedTaskRecipient) return;
    const source = selectedTask.task;
    const displayId = source.displayId?.trim() || source.id;
    setFollowUpSource({
      taskId: source.id,
      displayId,
      subject: source.subject,
      teamName: source.teamName,
      ownerName: selectedTaskRecipient.memberName,
    });
    setFollowUpTitle(`基于「${source.subject}」继续`);
    setFollowUpDescription(`基于任务 #${displayId}「${source.subject}」继续：\n`);
    setFollowUpError(null);
    setFollowUpDialogOpen(true);
  };

  const closeFollowUpDialog = (): void => {
    setFollowUpDialogOpen(false);
    setFollowUpSource(null);
    setFollowUpError(null);
  };

  const confirmFollowUpTask = async (): Promise<void> => {
    if (!followUpSource || !followUpTitle.trim() || followUpSubmitting) return;
    setFollowUpSubmitting(true);
    setFollowUpError(null);
    try {
      const task = await taskInbox.createTask(followUpSource.teamName, {
        subject: followUpTitle.trim(),
        description: followUpDescription.trim() || undefined,
        descriptionTaskRefs: [
          {
            taskId: followUpSource.taskId,
            displayId: followUpSource.displayId,
            teamName: followUpSource.teamName,
          },
        ],
        related: [followUpSource.taskId],
        owner: followUpSource.ownerName,
        startImmediately: true,
      });
      setFollowUpDialogOpen(false);
      setFollowUpSource(null);
      if (surface === 'tasks') {
        taskInbox.selectTask(`${followUpSource.teamName}:${task.id}`);
        setMode('tasks');
      } else {
        setMode('messages');
      }
      setMobileDetailOpen(true);
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : '任务创建失败，请稍后重试。');
    } finally {
      setFollowUpSubmitting(false);
    }
  };

  return (
    <div className="size-full min-h-0 min-w-0">
      <div className="grid size-full min-h-0 min-w-0 md:grid-cols-[minmax(300px,360px)_minmax(340px,1fr)]">
        <div
          className={`${mobileDetailOpen ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-[var(--surface-border-subtle)]`}
        >
          {surface === 'tasks' ? (
            <div
              role="tablist"
              aria-label="任务操作"
              className="flex shrink-0 items-center gap-1 border-b border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-3 py-2"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'tasks'}
                onClick={() => {
                  setMode('tasks');
                  setMobileDetailOpen(false);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  mode === 'tasks'
                    ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
                )}
              >
                <ClipboardList size={13} />
                任务列表
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'create'}
                onClick={() => {
                  setSubject('');
                  setDescription('');
                  setTaskInputFiles([]);
                  setCreateError(null);
                  setMode('create');
                  setMobileDetailOpen(false);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  mode === 'create'
                    ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
                )}
              >
                <Plus size={13} />
                创建任务
              </button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {mode === 'messages' ? (
              <InboxTaskMessageList
                messages={taskInbox.messages}
                selectedKey={taskInbox.selectedMessageKey}
                query={taskInbox.query}
                onQueryChange={taskInbox.setQuery}
                teamFilter={taskInbox.teamFilter}
                onTeamFilterChange={taskInbox.setTeamFilter}
                teamOptions={taskInbox.teamOptions}
                onSelect={(key) => {
                  taskInbox.selectMessage(key);
                  setMobileDetailOpen(true);
                }}
                onRefresh={taskInbox.refresh}
                loading={taskInbox.loading}
              />
            ) : mode === 'create' ? (
              <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
                <div className="border-b border-[var(--surface-border-subtle)] px-4 py-3">
                  <h2 className="text-sm font-medium text-[var(--color-text)]">选择执行者</h2>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    可以交给一个智能体，也可以交给一个小队协作完成。
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="执行者">
                  {recipientInbox.recipientOptions.map((option) => {
                    const key = recipientKey(option);
                    const selected = key === selectedRecipientKey;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setSelectedRecipientKey(key);
                          setCreateError(null);
                          setMobileDetailOpen(true);
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 border-b border-[var(--surface-border-subtle)] px-4 py-3 text-left transition-colors',
                          selected
                            ? 'bg-[var(--color-surface-selected)]'
                            : 'hover:bg-[var(--color-surface-hover)]'
                        )}
                      >
                        {option.kind === 'squad' ? (
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                            <UsersRound size={18} />
                          </span>
                        ) : (
                          <img
                            src={agentAvatarUrl(option.memberName, 36)}
                            alt=""
                            className="size-9 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--color-text)]">
                            {option.memberName}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                            {option.kind === 'squad'
                              ? `小队 · ${option.memberCount ?? 0} 名成员`
                              : option.teamDisplayName}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {recipientInbox.recipientOptions.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-text-muted)]">
                      <Bot size={30} className="opacity-30" />
                      <p className="text-sm">还没有可用的智能体或小队</p>
                      <p className="text-xs opacity-70">请先创建智能体或小队，再回来分配任务。</p>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <InboxTaskList
                view={taskInbox.view}
                onViewChange={taskInbox.setView}
                query={taskInbox.query}
                onQueryChange={taskInbox.setQuery}
                teamFilter={taskInbox.teamFilter}
                onTeamFilterChange={taskInbox.setTeamFilter}
                ownerFilter={taskInbox.ownerFilter}
                onOwnerFilterChange={taskInbox.setOwnerFilter}
                teamOptions={taskInbox.teamOptions}
                ownerOptions={taskInbox.ownerOptions}
                tasks={taskInbox.tasks}
                selectedKey={taskInbox.selectedKey}
                onSelect={(key) => {
                  taskInbox.selectTask(key);
                  setMobileDetailOpen(true);
                }}
                onRefresh={taskInbox.refresh}
                loading={taskInbox.loading}
                error={taskInbox.error}
              />
            )}
          </div>
        </div>

        <div
          className={`${mobileDetailOpen ? 'block' : 'hidden md:block'} min-h-0 min-w-0 bg-page-canvas`}
        >
          {mode === 'create' ? (
            selectedRecipient ? (
              <div className="flex h-full min-h-0 flex-col">
                <header className="flex shrink-0 items-center gap-3 border-b border-[var(--surface-border-subtle)] px-5 py-3.5">
                  <button
                    type="button"
                    onClick={() => setMobileDetailOpen(false)}
                    className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] md:hidden"
                    aria-label="返回执行者列表"
                  >
                    <ArrowLeft size={15} />
                  </button>
                  {selectedRecipient.kind === 'squad' ? (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                      <UsersRound size={18} />
                    </span>
                  ) : (
                    <img
                      src={agentAvatarUrl(selectedRecipient.memberName, 36)}
                      alt=""
                      className="size-9 rounded-full bg-[var(--color-surface-raised)]"
                    />
                  )}
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-[var(--color-text)]">
                      {selectedRecipient.kind === 'squad'
                        ? `交给小队 · ${selectedRecipient.memberName}`
                        : `交给 ${selectedRecipient.memberName}`}
                    </h2>
                    <p className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {selectedRecipient.kind === 'squad'
                        ? '创建后由成员圆桌选出队长、并行执行并统一交付'
                        : '创建后会立即开始执行'}
                    </p>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:px-8">
                  <div className="mx-auto w-full max-w-3xl">
                    <label className="block border-b border-[var(--color-border-subtle)] py-3">
                      <span className="text-xs text-[var(--color-text-muted)]">要完成什么</span>
                      <input
                        type="text"
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                        placeholder="例如：调研 Ozon 的入驻流程、费用和风险"
                        className="mt-2 h-10 w-full bg-transparent text-base font-medium text-[var(--color-text)] outline-none placeholder:font-normal placeholder:text-[var(--color-text-muted)]"
                        maxLength={160}
                        autoFocus
                      />
                    </label>
                    <label className="block py-4">
                      <span className="text-xs text-[var(--color-text-muted)]">
                        补充说明（可选）
                      </span>
                      <textarea
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="说明范围、目标、截止时间或你希望收到的结果形式。"
                        className="mt-2 min-h-40 w-full resize-y bg-transparent text-sm leading-7 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                        maxLength={20_000}
                      />
                    </label>
                    <TaskInputPicker files={taskInputFiles} onChange={setTaskInputFiles} />
                    {createError ? (
                      <p className="mb-3 mt-3 text-xs text-red-500">{createError}</p>
                    ) : null}
                    <div className="flex justify-end border-t border-[var(--color-border-subtle)] pt-4">
                      <button
                        type="button"
                        disabled={!subject.trim() || creating}
                        onClick={() => void submitTask()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-indigo-600 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus size={14} />
                        {creating ? '正在创建…' : '创建并开始'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
                <Bot size={34} className="opacity-25" />
                <p className="text-sm">选择一个智能体</p>
                <p className="text-xs opacity-70">选择后即可填写并创建任务。</p>
              </div>
            )
          ) : selectedTask ? (
            <TaskDetailPanel
              key={selectedTask.key}
              presentation="inline"
              variant={taskModel.isFullTeamLoaded ? 'team' : 'global'}
              loading={taskModel.loading}
              task={taskModel.task ?? selectedTask.task}
              teamName={selectedTask.task.teamName}
              kanbanTaskState={taskModel.kanbanTaskState}
              taskMap={
                taskModel.taskMap.size > 0
                  ? taskModel.taskMap
                  : new Map([[selectedTask.task.id, selectedTask.task]])
              }
              members={taskModel.members}
              compactForInbox
              deliveriesContent={
                detailTask ? (
                  <TaskReviewThread
                    deliveries={detailTask.deliveries}
                    feedbackItems={detailTask.feedbackItems}
                    historyEvents={detailTask.historyEvents}
                    reviewState={getReviewStateFromTask(detailTask)}
                    owner={detailTask.owner}
                    members={taskModel.members}
                    needsClarification={detailTask.needsClarification}
                    clarificationQuestion={clarificationQuestion}
                    onSubmitDiscussion={submitThreadDiscussion}
                    onOpenHunk={
                      taskModel.isFullTeamLoaded
                        ? (changeKey) =>
                            taskModel.viewChanges(
                              detailTask.id,
                              extractFilePathFromChangeKey(changeKey)
                            )
                        : undefined
                    }
                    onRequestChanges={(text, anchor) =>
                      taskInbox.requestChanges(
                        selectedTask.task.teamName,
                        detailTask.id,
                        text,
                        undefined,
                        anchor
                      )
                    }
                    precipitationSuggestion={precipitationSuggestion}
                  />
                ) : undefined
              }
              onScrollToTask={(taskRef) => {
                if (surface === 'inbox') {
                  openTask(taskRef.teamName ?? selectedTask.task.teamName, taskRef.taskId);
                  return;
                }
                taskInbox.selectReferencedTask(taskRef);
                setMode('tasks');
                setMobileDetailOpen(true);
              }}
              onOwnerChange={
                taskModel.isFullTeamLoaded
                  ? (taskId, owner) => {
                      void taskInbox.updateOwner(selectedTask.task.teamName, taskId, owner);
                    }
                  : undefined
              }
              onViewChanges={
                taskModel.isFullTeamLoaded
                  ? (taskId, filePath) => taskModel.viewChanges(taskId, filePath)
                  : undefined
              }
              headerExtra={
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMobileDetailOpen(false)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] md:hidden"
                  >
                    <ArrowLeft size={13} />
                    返回列表
                  </button>
                  {/* 评审入口：messages / tasks 两种模式在 review 态都显示「满意并归档」 */}
                  {selectedTaskReviewState === 'review' ? (
                    <button
                      type="button"
                      disabled={reviewSubmitting}
                      onClick={approveCurrentTask}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                    >
                      <CheckCircle2 size={12} />
                      满意并归档
                    </button>
                  ) : null}
                  {mode === 'messages' ? (
                    <>
                      {selectedTaskOwnerMember ? (
                        <button
                          type="button"
                          onClick={() => setTuningOpen(true)}
                          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                          title="改变智能体长期的回答和做事方式，不修改当前任务"
                        >
                          <SlidersHorizontal size={12} />
                          调教员工
                        </button>
                      ) : null}
                      {selectedTaskRecipient && selectedTaskReviewState !== 'review' ? (
                        <button
                          type="button"
                          onClick={startFollowUpTask}
                          className="inline-flex items-center gap-1 rounded-md border border-indigo-500/25 bg-indigo-500/[0.05] px-2.5 py-1 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-500/10 dark:text-indigo-300"
                          title="基于当前结果创建一个新的长周期任务"
                        >
                          <ListPlus size={12} />
                          新建后续任务
                        </button>
                      ) : null}
                      {reviewError ? (
                        <span
                          className="max-w-40 truncate text-[10px] text-rose-500"
                          title={reviewError}
                        >
                          {reviewError}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          openTask(selectedTask.task.teamName, selectedTask.task.id);
                        }}
                        className="rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                      >
                        打开完整任务
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('messages');
                        taskInbox.selectMessage(selectedTask.key);
                      }}
                      className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                    >
                      打开收件箱
                    </button>
                  )}
                </div>
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
              {mode === 'messages' ? (
                <MessageSquare size={34} className="opacity-25" />
              ) : (
                <ClipboardList size={34} className="opacity-25" />
              )}
              <p className="text-sm">
                {mode === 'messages' ? '选择一条任务反馈' : '选择一个任务查看详情'}
              </p>
              <p className="text-xs opacity-70">
                {mode === 'messages'
                  ? '你可以在当前任务内补充、纠正或继续推进。'
                  : '执行进度、问题和交付结果会显示在这里。'}
              </p>
            </div>
          )}
        </div>
      </div>
      <AgentTuningDialog
        open={tuningOpen}
        teamName={selectedTask?.task.teamName ?? ''}
        member={selectedTaskOwnerMember}
        onClose={() => setTuningOpen(false)}
      />
      <Dialog
        open={followUpDialogOpen && followUpSource !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeFollowUpDialog();
        }}
      >
        <DialogContent className="sm:max-w-lg" data-testid="follow-up-dialog">
          <DialogHeader>
            <DialogTitle>新建后续任务</DialogTitle>
            <DialogDescription>
              基于任务 #{followUpSource?.displayId}「{followUpSource?.subject}」创建新的长周期任务，
              确认后立即开始执行，不会修改当前任务。
            </DialogDescription>
          </DialogHeader>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">标题（必填）</span>
            <input
              type="text"
              value={followUpTitle}
              onChange={(event) => setFollowUpTitle(event.target.value)}
              data-testid="follow-up-title"
              className="mt-1.5 h-10 w-full rounded-md border border-[var(--color-border-subtle)] bg-transparent px-3 text-sm text-[var(--color-text)] outline-none focus:border-indigo-500/50"
              maxLength={160}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">描述（可选）</span>
            <textarea
              value={followUpDescription}
              onChange={(event) => setFollowUpDescription(event.target.value)}
              data-testid="follow-up-description"
              className="mt-1.5 min-h-28 w-full resize-y rounded-md border border-[var(--color-border-subtle)] bg-transparent px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none focus:border-indigo-500/50"
              maxLength={20_000}
            />
          </label>
          {followUpError ? <p className="text-xs text-red-500">{followUpError}</p> : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeFollowUpDialog}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!followUpTitle.trim() || followUpSubmitting}
              onClick={() => void confirmFollowUpTask()}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ListPlus size={13} />
              {followUpSubmitting ? '正在创建…' : '创建并开始'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={approveConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setApproveConfirmOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="approve-confirm-dialog">
          <DialogHeader>
            <DialogTitle>满意并归档</DialogTitle>
            <DialogDescription>
              还有 {openFeedbackItems.length} 条待处理反馈，仍要归档吗？
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto py-1">
            {openFeedbackItems.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]"
              >
                <CircleDot size={12} className="mt-0.5 shrink-0 text-amber-400" />
                <span className="min-w-0 break-words">{item.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            归档后这些反馈将一并标记为已解决。
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setApproveConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={reviewSubmitting}
              onClick={() => {
                setApproveConfirmOpen(false);
                void runApprove(true);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              仍要归档
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { LightboxLockProvider } from '@renderer/components/team/attachments/ImageLightbox';
import { CollapsibleTeamSection } from '@renderer/components/team/CollapsibleTeamSection';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { Input } from '@renderer/components/ui/input';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { TiptapEditor } from '@renderer/components/ui/tiptap';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  displayMemberName,
  KANBAN_COLUMN_DISPLAY,
  REVIEW_STATE_DISPLAY,
  TASK_STATUS_LABELS,
  TASK_STATUS_STYLES,
} from '@renderer/utils/memberHelpers';
import { extractFilePathFromChangeKey } from '@renderer/utils/reviewKey';
import { resolveTaskChangePresenceFromResult } from '@renderer/utils/taskChangePresence';
import {
  buildTaskChangeRequestOptions,
  buildTaskChangeSignature,
  deriveTaskSince,
} from '@renderer/utils/taskChangeRequest';
import {
  linkifyTaskIdsInMarkdown,
  type ParsedTaskLinkHref,
  parseTaskLinkHref,
} from '@renderer/utils/taskReferenceUtils';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';
import { canDisplayTaskChanges } from '@shared/utils/taskChangeState';
import {
  deriveTaskDisplayId,
  formatTaskDisplayLabel,
  taskMatchesRef,
} from '@shared/utils/taskIdentity';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlignLeft,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Check,
  Clock,
  FileDiff,
  GitCompareArrows,
  HelpCircle,
  History,
  ImageIcon,
  Link2,
  Loader2,
  PackageCheck,
  Pencil,
  PenLine,
  RefreshCw,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';

const TASK_CHANGES_AUTO_REFRESH_MS = 20_000;

import { SourceMessageAttachments } from '../attachments/SourceMessageAttachments';

import { WorkflowTimeline } from './StatusHistoryTimeline';
import { TaskAttachments } from './TaskAttachments';
import { TaskDeliveriesSection } from './TaskDeliveriesSection';

import type {
  FileChangeSummary,
  KanbanTaskState,
  ResolvedTeamMember,
  TaskChangeSetV2,
  TeamTaskWithKanban,
} from '@shared/types';

type TaskDetailPresentation = 'dialog' | 'inline';

const TaskDetailTitle = ({
  presentation,
  ...props
}: Readonly<
  { presentation: TaskDetailPresentation } & React.ComponentPropsWithoutRef<'h2'>
>): React.JSX.Element =>
  presentation === 'inline'
    ? React.createElement('h2', props)
    : React.createElement(DialogTitle, props);

const TaskDetailDescription = ({
  presentation,
  ...props
}: Readonly<
  { presentation: TaskDetailPresentation } & React.ComponentPropsWithoutRef<'p'>
>): React.JSX.Element =>
  presentation === 'inline'
    ? React.createElement('p', props)
    : React.createElement(DialogDescription, props);

export interface TaskDetailPanelProps {
  open?: boolean;
  presentation?: TaskDetailPresentation;
  loading?: boolean;
  variant?: 'team' | 'global';
  task: TeamTaskWithKanban | null;
  teamName: string;
  kanbanTaskState?: KanbanTaskState;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onClose?: () => void;
  onScrollToTask?: (target: ParsedTaskLinkHref) => void;
  onOwnerChange?: (taskId: string, owner: string | null) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
  onOpenInEditor?: (filePath: string) => void;
  onDeleteTask?: (taskId: string) => void;
  /** Consumer-focused presentation: prioritize goal, deliverable, and collaboration. */
  compactForInbox?: boolean;
  /** 收件箱提供的成果区自定义内容（评审邮件线程）；缺省为只读交付成果区 */
  deliveriesContent?: React.ReactNode;
  /** Extra content rendered in the dialog header (e.g. "Open team" button). */
  headerExtra?: React.ReactNode;
}

export const TaskDetailPanel = ({
  open = true,
  presentation = 'dialog',
  loading = false,
  variant = 'team',
  task,
  teamName,
  kanbanTaskState,
  taskMap,
  members,
  onClose = () => undefined,
  onScrollToTask,
  onOwnerChange,
  onViewChanges,
  onOpenInEditor,
  onDeleteTask,
  compactForInbox = false,
  deliveriesContent,
  headerExtra,
}: TaskDetailPanelProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);
  const { isLight } = useTheme();
  const currentTask = task ? (taskMap.get(task.id) ?? task) : null;
  const updateTaskFields = useStore((s) => s.updateTaskFields);
  const recordTaskChangePresence = useStore((s) => s.recordTaskChangePresence);
  const setSelectedTeamTaskChangePresence = useStore((s) => s.setSelectedTeamTaskChangePresence);

  const [changesSectionOpen, setChangesSectionOpen] = useState(false);
  const [taskChangesFiles, setTaskChangesFiles] = useState<FileChangeSummary[] | null>(null);
  const [taskChangesLoading, setTaskChangesLoading] = useState(false);
  const [taskChangesError, setTaskChangesError] = useState<string | null>(null);
  const loadedTaskChangeSummaryKeyRef = useRef<string | null>(null);
  const taskChangesLoadInFlightKeysRef = useRef<Set<string>>(new Set());
  const currentTaskChangeSummaryKeyRef = useRef<string | null>(null);

  // Inline editing: subject
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [savingSubject, setSavingSubject] = useState(false);

  // Inline editing: description
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);

  const startEditSubject = useCallback(() => {
    if (!currentTask) return;
    setSubjectDraft(currentTask.subject);
    setEditingSubject(true);
  }, [currentTask]);

  const saveSubject = useCallback(async () => {
    if (!currentTask || savingSubject) return;
    const trimmed = subjectDraft.trim();
    if (!trimmed || trimmed === currentTask.subject) {
      setEditingSubject(false);
      return;
    }
    setSavingSubject(true);
    try {
      await updateTaskFields(teamName, currentTask.id, { subject: trimmed });
      setEditingSubject(false);
    } finally {
      setSavingSubject(false);
    }
  }, [currentTask, subjectDraft, savingSubject, teamName, updateTaskFields]);

  const startEditDescription = useCallback(() => {
    if (!currentTask) return;
    setDescriptionDraft(currentTask.description ?? '');
    setEditingDescription(true);
  }, [currentTask]);

  const saveDescription = useCallback(async () => {
    if (!currentTask || savingDescription) return;
    const newDesc = descriptionDraft.trim();
    if (newDesc === (currentTask.description ?? '')) {
      setEditingDescription(false);
      return;
    }
    setSavingDescription(true);
    try {
      await updateTaskFields(teamName, currentTask.id, { description: newDesc });
      setEditingDescription(false);
    } finally {
      setSavingDescription(false);
    }
  }, [currentTask, descriptionDraft, savingDescription, teamName, updateTaskFields]);

  // Reset editing state on dialog close or task change
  useEffect(() => {
    setEditingSubject(false);
    setEditingDescription(false);
  }, [open, currentTask?.id]);

  useEffect(() => {
    setChangesSectionOpen(false);
    setTaskChangesFiles(null);
    setTaskChangesLoading(false);
    setTaskChangesError(null);
  }, [open, currentTask?.id]);

  // Track whether a lightbox is open to block Dialog dismiss events.
  // Using a ref for synchronous reads (no render cycle delay) + a stable
  // callback so context consumers never cause re-renders.
  const lightboxOpenRef = useRef(false);
  const setLightboxOpen = useCallback((isOpen: boolean) => {
    lightboxOpenRef.current = isOpen;
  }, []);

  // Callback-ref + useState for the scrollable DialogContent.
  const [dialogContentEl, setDialogContentEl] = useState<HTMLDivElement | null>(null);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const sourceAttachmentCount =
    currentTask?.sourceMessageId && currentTask?.sourceMessage?.attachments?.length
      ? currentTask.sourceMessage.attachments.length
      : 0;
  const relatedFileCount = (currentTask?.attachments?.length ?? 0) + sourceAttachmentCount;

  // Lazy-load task changes for any displayable state (in_progress, review, approved, completed).
  const canShowTaskChanges = currentTask ? canDisplayTaskChanges(currentTask) : false;
  const taskSince = useMemo(() => deriveTaskSince(currentTask), [currentTask]);
  const taskChangeRequestOptions = useMemo(
    () => (currentTask ? buildTaskChangeRequestOptions(currentTask) : null),
    [currentTask]
  );
  const taskChangeRequestSignature = useMemo(
    () => (taskChangeRequestOptions ? buildTaskChangeSignature(taskChangeRequestOptions) : null),
    [taskChangeRequestOptions]
  );
  const currentTaskChangeSummaryKey = useMemo(
    () =>
      currentTask
        ? `${teamName}:${currentTask.id}:${taskChangeRequestSignature ?? 'default'}`
        : null,
    [currentTask, teamName, taskChangeRequestSignature]
  );
  const taskChangeSummaryOptions = useMemo(
    () =>
      currentTask
        ? buildTaskChangeRequestOptions(currentTask, {
            since: taskSince,
            summaryOnly: true,
          })
        : null,
    [currentTask, taskSince]
  );
  const setTaskNeedsClarification = useStore((s) => s.setTaskNeedsClarification);

  useEffect(() => {
    currentTaskChangeSummaryKeyRef.current = currentTaskChangeSummaryKey;
  }, [currentTaskChangeSummaryKey]);

  const loadTaskChangeSummary = useCallback(
    async (forceFresh = false): Promise<TaskChangeSetV2 | null> => {
      if (
        !currentTask ||
        !taskChangeSummaryOptions ||
        variant !== 'team' ||
        !canShowTaskChanges ||
        !onViewChanges
      ) {
        return null;
      }
      const data = await api.review.getTaskChanges(teamName, currentTask.id, {
        ...taskChangeSummaryOptions,
        forceFresh,
      });
      return data;
    },
    [canShowTaskChanges, currentTask, onViewChanges, taskChangeSummaryOptions, teamName, variant]
  );

  const syncTaskChangeSummaryResult = useCallback(
    (data: TaskChangeSetV2 | null) => {
      setTaskChangesFiles(data?.files ?? null);
      const nextPresence = data ? resolveTaskChangePresenceFromResult(data) : null;
      if (currentTask && taskChangeRequestOptions) {
        recordTaskChangePresence(teamName, currentTask.id, taskChangeRequestOptions, nextPresence);
      }
      if (currentTask) {
        setSelectedTeamTaskChangePresence(teamName, currentTask.id, nextPresence ?? 'unknown');
      }
    },
    [
      currentTask,
      recordTaskChangePresence,
      setSelectedTeamTaskChangePresence,
      taskChangeRequestOptions,
      teamName,
    ]
  );

  const requestTaskChangeSummary = useCallback(
    async ({
      forceFresh = false,
      showSpinner = false,
      preserveFilesOnError = false,
    }: {
      forceFresh?: boolean;
      showSpinner?: boolean;
      preserveFilesOnError?: boolean;
    } = {}): Promise<void> => {
      const requestKey = currentTaskChangeSummaryKeyRef.current;
      if (
        !requestKey ||
        !currentTask ||
        variant !== 'team' ||
        !canShowTaskChanges ||
        !onViewChanges
      )
        return;
      if (taskChangesLoadInFlightKeysRef.current.has(requestKey)) return;

      taskChangesLoadInFlightKeysRef.current.add(requestKey);
      if (showSpinner) {
        setTaskChangesLoading(true);
      }
      setTaskChangesError(null);

      try {
        const data = await loadTaskChangeSummary(forceFresh);
        if (currentTaskChangeSummaryKeyRef.current !== requestKey) {
          return;
        }
        syncTaskChangeSummaryResult(data);
      } catch (error) {
        if (currentTaskChangeSummaryKeyRef.current !== requestKey) {
          return;
        }
        if (!preserveFilesOnError) {
          setTaskChangesFiles(null);
        }
        setTaskChangesError(
          error instanceof Error ? error.message : 'Failed to load task changes summary'
        );
      } finally {
        taskChangesLoadInFlightKeysRef.current.delete(requestKey);
        if (showSpinner && currentTaskChangeSummaryKeyRef.current === requestKey) {
          setTaskChangesLoading(false);
        }
      }
    },
    [
      canShowTaskChanges,
      currentTask,
      loadTaskChangeSummary,
      onViewChanges,
      syncTaskChangeSummaryResult,
      variant,
    ]
  );

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !canShowTaskChanges || !onViewChanges || !changesSectionOpen)
      return;

    const summaryKey = currentTaskChangeSummaryKey;
    if (loadedTaskChangeSummaryKeyRef.current === summaryKey) {
      return;
    }
    loadedTaskChangeSummaryKeyRef.current = summaryKey;

    // Show full loading state only when no files are cached yet;
    // otherwise let the refresh button spinner indicate background reload.
    void requestTaskChangeSummary({
      forceFresh: false,
      showSpinner: !taskChangesFiles || taskChangesFiles.length === 0,
      preserveFilesOnError: false,
    });
  }, [
    changesSectionOpen,
    open,
    currentTask,
    canShowTaskChanges,
    teamName,
    onViewChanges,
    currentTaskChangeSummaryKey,
    taskChangeRequestSignature,
    variant,
    requestTaskChangeSummary,
    taskChangesFiles,
  ]);

  useEffect(() => {
    if (!open || !changesSectionOpen) {
      loadedTaskChangeSummaryKeyRef.current = null;
    }
  }, [open, changesSectionOpen]);

  useEffect(() => {
    if (variant !== 'team') return;
    if (!open || !currentTask || !canShowTaskChanges || !onViewChanges || !changesSectionOpen) {
      return;
    }

    const timer = window.setInterval(() => {
      void requestTaskChangeSummary({
        forceFresh: true,
        showSpinner: false,
        preserveFilesOnError: true,
      });
    }, TASK_CHANGES_AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    changesSectionOpen,
    open,
    currentTask,
    canShowTaskChanges,
    onViewChanges,
    requestTaskChangeSummary,
    variant,
  ]);

  const handleRefreshChanges = useCallback(() => {
    void requestTaskChangeSummary({
      forceFresh: true,
      showSpinner: true,
      preserveFilesOnError: false,
    });
  }, [requestTaskChangeSummary]);

  // hunk 反馈锚点：关闭详情并打开变更审查，定位到对应文件
  const handleOpenHunkAnchor = useCallback(
    (changeKey: string) => {
      if (!currentTask || !onViewChanges) return;
      handleClose();
      onViewChanges(currentTask.id, extractFilePathFromChangeKey(changeKey));
    },
    [currentTask, handleClose, onViewChanges]
  );

  const handleDependencyClick = (target: ParsedTaskLinkHref): void => {
    // Resolve short displayId (e.g. "8ce74455") only inside the current team.
    // Cross-team links retain their canonical composite identity for the caller.
    let resolvedId = target.taskId;
    if ((!target.teamName || target.teamName === teamName) && !taskMap.has(target.taskId)) {
      for (const [fullId, mappedTask] of taskMap) {
        if (taskMatchesRef(mappedTask, target.taskId)) {
          resolvedId = fullId;
          break;
        }
      }
    }
    handleClose();
    onScrollToTask?.({
      ...target,
      taskId: resolvedId,
      teamName: target.teamName ?? teamName,
    });
  };

  const handleChangesSectionOpenChange = useCallback((isOpen: boolean): void => {
    setChangesSectionOpen(isOpen);
  }, []);

  if (loading) {
    const loadingContent = (
      <>
        <DialogHeader>
          <TaskDetailTitle presentation={presentation}>正在加载任务…</TaskDetailTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          <span>正在获取团队数据</span>
        </div>
      </>
    );
    if (presentation === 'inline') {
      return (
        <div
          className="flex h-full flex-col justify-center gap-3 p-6"
          data-task-detail-presentation="inline"
        >
          {loadingContent}
        </div>
      );
    }
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-4xl" data-task-detail-presentation="dialog">
          {loadingContent}
        </DialogContent>
      </Dialog>
    );
  }

  if (!currentTask) {
    const missingContent = (
      <DialogHeader>
        <TaskDetailTitle presentation={presentation}>未找到任务</TaskDetailTitle>
      </DialogHeader>
    );
    if (presentation === 'inline') {
      return (
        <div
          className="flex h-full flex-col justify-center p-6"
          data-task-detail-presentation="inline"
        >
          {missingContent}
        </div>
      );
    }
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="sm:max-w-4xl" data-task-detail-presentation="dialog">
          {missingContent}
        </DialogContent>
      </Dialog>
    );
  }

  const kanbanColumn =
    kanbanTaskState?.column ??
    getTaskKanbanColumn({
      reviewState: currentTask.reviewState,
      kanbanColumn: currentTask.kanbanColumn,
    });
  const status = currentTask.status;
  const statusStyle =
    kanbanColumn && KANBAN_COLUMN_DISPLAY[kanbanColumn]
      ? {
          bg: KANBAN_COLUMN_DISPLAY[kanbanColumn].bg,
          text: KANBAN_COLUMN_DISPLAY[kanbanColumn].text,
        }
      : TASK_STATUS_STYLES[status];
  const statusLabel =
    kanbanColumn && KANBAN_COLUMN_DISPLAY[kanbanColumn]
      ? KANBAN_COLUMN_DISPLAY[kanbanColumn].label
      : TASK_STATUS_LABELS[status];
  const blockedByIds = currentTask.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = currentTask.blocks?.filter((id) => id.length > 0) ?? [];
  const relatedIds = (currentTask.related ?? []).filter(
    (id) => id.length > 0 && id !== currentTask.id
  );
  const relatedByIds = Array.from(taskMap.values())
    .filter(
      (t) =>
        t.id !== currentTask.id && Array.isArray(t.related) && t.related.includes(currentTask.id)
    )
    .map((t) => t.id);
  const isTodo = status === 'pending' && !kanbanColumn;
  const canReassign = isTodo && onOwnerChange;

  const detailContent = (
    <LightboxLockProvider value={setLightboxOpen}>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
            {formatTaskDisplayLabel(currentTask)}
          </Badge>
          {(currentTask.reviewState === 'approved' || currentTask.reviewState === 'review') &&
          currentTask.reviewer &&
          currentTask.reviewer !== 'user' ? (
            (() => {
              const reviewerColor = colorMap.get(currentTask.reviewer);
              const colors =
                currentTask.reviewState === 'review'
                  ? getTeamColorSet('blue')
                  : getTeamColorSet(reviewerColor ?? '');
              const reviewerBadgeStyle = {
                backgroundColor: getThemedBadge(colors, isLight),
                color: getThemedText(colors, isLight),
                borderTop: `1px solid ${getThemedBorder(colors, isLight)}40`,
                borderRight: `1px solid ${getThemedBorder(colors, isLight)}40`,
                borderBottom: `1px solid ${getThemedBorder(colors, isLight)}40`,
              };
              const lastReviewEvent = currentTask.historyEvents
                ?.filter((e) =>
                  currentTask.reviewState === 'approved'
                    ? e.type === 'review_approved'
                    : e.type === 'review_requested' || e.type === 'review_started'
                )
                .at(-1);
              const reviewDate = lastReviewEvent ? new Date(lastReviewEvent.timestamp) : undefined;
              const reviewTimeLabel =
                reviewDate && !isNaN(reviewDate.getTime())
                  ? Date.now() - reviewDate.getTime() < 24 * 60 * 60 * 1000
                    ? formatDistanceToNow(reviewDate, { addSuffix: true })
                    : format(reviewDate, 'MMM d, yyyy HH:mm')
                  : undefined;
              const badge = (
                <span className="inline-flex items-stretch">
                  <span
                    className={`inline-flex items-center rounded-l-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
                  >
                    {statusLabel}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-r-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={reviewerBadgeStyle}
                  >
                    <img
                      src={
                        avatarMap.get(currentTask.reviewer) ??
                        agentAvatarUrl(currentTask.reviewer, 18)
                      }
                      alt=""
                      className="size-4 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
                      loading="lazy"
                    />
                    {displayMemberName(currentTask.reviewer)}
                  </span>
                </span>
              );
              return reviewTimeLabel ? (
                <Tooltip>
                  <TooltipTrigger asChild>{badge}</TooltipTrigger>
                  <TooltipContent side="bottom">{reviewTimeLabel}</TooltipContent>
                </Tooltip>
              ) : (
                badge
              );
            })()
          ) : (
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
            >
              {statusLabel}
            </span>
          )}
          {currentTask.reviewState === 'needsFix' ? (
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
            >
              {REVIEW_STATE_DISPLAY.needsFix.label}
            </span>
          ) : null}
          {headerExtra ? <div className="ml-auto mr-4">{headerExtra}</div> : null}
        </div>
        {editingSubject ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={subjectDraft}
              onChange={(e) => setSubjectDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  void saveSubject();
                }
                if (e.key === 'Escape') setEditingSubject(false);
              }}
              onBlur={() => void saveSubject()}
              disabled={savingSubject}
              className="h-8 text-base"
            />
            {savingSubject ? <Loader2 size={14} className="animate-spin" /> : null}
          </div>
        ) : (
          <TaskDetailTitle
            presentation={presentation}
            className="group flex cursor-pointer items-center gap-1.5 text-base hover:text-[var(--color-text)]"
            onClick={startEditSubject}
          >
            {currentTask.subject}
            <Pencil
              size={12}
              className="shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
            />
          </TaskDetailTitle>
        )}
        {currentTask.activeForm ? (
          <TaskDetailDescription presentation={presentation}>
            {currentTask.activeForm}
          </TaskDetailDescription>
        ) : null}
      </DialogHeader>

      {/* Metadata */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {canReassign ? (
            <MemberSelect
              members={members}
              value={currentTask.owner ?? null}
              onChange={(v) => onOwnerChange(currentTask.id, v)}
              allowUnassigned
              size="sm"
              className="min-w-[160px]"
            />
          ) : currentTask.owner ? (
            <MemberBadge
              name={currentTask.owner}
              color={colorMap.get(currentTask.owner)}
              size="md"
            />
          ) : (
            <span className="text-xs italic text-[var(--color-text-muted)]">未分配</span>
          )}
        </div>
        {currentTask.createdBy ? (
          <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
            <PenLine size={12} />
            <span className="text-[var(--color-text-secondary)]">{currentTask.createdBy}</span>
          </div>
        ) : null}
        {currentTask.createdAt
          ? (() => {
              const date = new Date(currentTask.createdAt);
              return isNaN(date.getTime()) ? null : (
                <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                  <Clock size={12} />
                  <span className="text-[var(--color-text-secondary)]">
                    {formatDistanceToNow(date, { addSuffix: true })}
                  </span>
                </div>
              );
            })()
          : null}
        {onDeleteTask && currentTask && currentTask.status !== 'in_progress' ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 text-xs text-[var(--color-text-muted)] hover:text-red-400"
            onClick={() => {
              onDeleteTask(currentTask.id);
              handleClose();
            }}
          >
            <Trash2 size={12} />
            删除
          </Button>
        ) : null}
      </div>

      {/* Clarification banner */}
      {!compactForInbox && currentTask.needsClarification ? (
        <div
          className={`flex items-center justify-between rounded-md px-3 py-2 text-xs ${
            currentTask.needsClarification === 'user'
              ? 'border border-red-500/20 bg-red-500/10 text-red-400'
              : 'border border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
          }`}
        >
          <span className="flex items-center gap-1.5">
            <HelpCircle size={14} />
            {currentTask.needsClarification === 'user'
              ? '等待你补充说明'
              : '等待 Loop Lead 补充说明'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              void setTaskNeedsClarification(teamName, currentTask.id, null);
            }}
          >
            标记为已解决
          </Button>
        </div>
      ) : null}

      {/* Related tasks & Dependencies — 2-column grid */}
      {(relatedIds.length > 0 ||
        relatedByIds.length > 0 ||
        blockedByIds.length > 0 ||
        blocksIds.length > 0) && (
        <div className="space-y-2">
          {/* "Related tasks" header — only if links exist */}
          {(relatedIds.length > 0 || relatedByIds.length > 0) && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <Link2 size={12} />
              关联任务
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {relatedIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-[var(--color-text-muted)]">关联到</span>
                {relatedIds.map((id) => {
                  const depTask = taskMap.get(id);
                  const label = depTask
                    ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                    : `#${deriveTaskDisplayId(id)}`;
                  return (
                    <Tooltip key={`related:${currentTask.id}:${id}`}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-300 transition-colors hover:bg-purple-500/25"
                          onClick={() => handleDependencyClick({ taskId: id })}
                        >
                          {depTask
                            ? formatTaskDisplayLabel(depTask)
                            : `#${deriveTaskDisplayId(id)}`}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}

            {relatedByIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-[var(--color-text-muted)]">被关联自</span>
                {relatedByIds.map((id) => {
                  const depTask = taskMap.get(id);
                  const label = depTask
                    ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                    : `#${deriveTaskDisplayId(id)}`;
                  return (
                    <Tooltip key={`related-by:${currentTask.id}:${id}`}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-300 transition-colors hover:bg-fuchsia-500/25"
                          onClick={() => handleDependencyClick({ taskId: id })}
                        >
                          {depTask
                            ? formatTaskDisplayLabel(depTask)
                            : `#${deriveTaskDisplayId(id)}`}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}

            {blockedByIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-0.5 text-xs text-yellow-700 dark:text-yellow-300">
                  <ArrowLeftFromLine size={12} />
                  阻塞于
                </span>
                {blockedByIds.map((id) => {
                  const depTask = taskMap.get(id);
                  const isCompleted = depTask?.status === 'completed';
                  const label = depTask
                    ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                    : `#${deriveTaskDisplayId(id)}`;
                  return (
                    <Tooltip key={id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            isCompleted
                              ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                              : 'bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/25 dark:text-yellow-300'
                          } cursor-pointer`}
                          onClick={() => handleDependencyClick({ taskId: id })}
                        >
                          {depTask
                            ? formatTaskDisplayLabel(depTask)
                            : `#${deriveTaskDisplayId(id)}`}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}

            {blocksIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-0.5 text-xs text-indigo-600 dark:text-indigo-400">
                  <ArrowRightFromLine size={12} />
                  阻塞
                </span>
                {blocksIds.map((id) => {
                  const depTask = taskMap.get(id);
                  const isCompleted = depTask?.status === 'completed';
                  const label = depTask
                    ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
                    : `#${deriveTaskDisplayId(id)}`;
                  return (
                    <Tooltip key={id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            isCompleted
                              ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                              : 'bg-indigo-500/15 text-indigo-600 hover:bg-indigo-500/25 dark:text-indigo-400'
                          } cursor-pointer`}
                          onClick={() => handleDependencyClick({ taskId: id })}
                        >
                          {depTask
                            ? formatTaskDisplayLabel(depTask)
                            : `#${deriveTaskDisplayId(id)}`}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Sections container with uniform spacing */}
      <div className="min-w-0 space-y-1">
        {/* Description */}
        <CollapsibleTeamSection
          title="描述"
          icon={<AlignLeft size={14} />}
          contentClassName="pl-2.5"
          headerClassName="-mx-6 w-[calc(100%+3rem)]"
          headerContentClassName="pl-6"
          defaultOpen
        >
          {editingDescription ? (
            <div className="space-y-2">
              <TiptapEditor
                content={descriptionDraft}
                onChange={setDescriptionDraft}
                placeholder="任务描述（支持 Markdown）"
                autoFocus
                minHeight="120px"
                maxHeight="200px"
                toolbar
                disabled={savingDescription}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={savingDescription}
                  onClick={() => void saveDescription()}
                >
                  {savingDescription ? (
                    <Loader2 size={12} className="mr-1 animate-spin" />
                  ) : (
                    <Check size={12} className="mr-1" />
                  )}
                  保存
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={savingDescription}
                  onClick={() => setEditingDescription(false)}
                >
                  <X size={12} className="mr-1" />
                  取消
                </Button>
              </div>
            </div>
          ) : currentTask.description ? (
            <div
              className="group relative"
              onClickCapture={
                onScrollToTask
                  ? (e) => {
                      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
                        'a[href^="task://"]'
                      );
                      if (link) {
                        e.preventDefault();
                        e.stopPropagation();
                        const href = link.getAttribute('href');
                        const parsed = href ? parseTaskLinkHref(href) : null;
                        if (parsed?.taskId) handleDependencyClick(parsed);
                      }
                    }
                  : undefined
              }
            >
              <ExpandableContent collapsedHeight={200}>
                <MarkdownViewer
                  content={linkifyTaskIdsInMarkdown(
                    currentTask.description,
                    currentTask.descriptionTaskRefs
                  )}
                  maxHeight="max-h-none"
                  bare
                />
              </ExpandableContent>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="absolute right-0 top-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] group-hover:opacity-100"
                    onClick={startEditDescription}
                  >
                    <Pencil size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">编辑描述</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <button
              type="button"
              className="text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
              onClick={startEditDescription}
            >
              点击添加描述...
            </button>
          )}
        </CollapsibleTeamSection>

        {/* 交付成果 + 反馈待办点（deliveries 追加式版本化，取代旧的单一 result 卡片） */}
        {(currentTask.deliveries?.length ?? 0) > 0 ||
        (currentTask.feedbackItems?.length ?? 0) > 0 ? (
          <CollapsibleTeamSection
            key={`task-deliveries:${currentTask.id}`}
            title="交付成果"
            icon={<PackageCheck size={14} />}
            headerExtra={
              (currentTask.feedbackItems ?? []).some((item) => item.status === 'open') ? (
                <span className="pointer-events-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
                  {
                    (currentTask.feedbackItems ?? []).filter((item) => item.status === 'open')
                      .length
                  }{' '}
                  条待处理
                </span>
              ) : null
            }
            contentClassName="pl-2.5"
            headerClassName="-mx-6 w-[calc(100%+3rem)]"
            headerContentClassName="pl-6"
            defaultOpen
          >
            {deliveriesContent ?? (
              <TaskDeliveriesSection
                deliveries={currentTask.deliveries}
                feedbackItems={currentTask.feedbackItems}
                onOpenHunk={variant === 'team' && onViewChanges ? handleOpenHunkAnchor : undefined}
                reviewLocationHint={
                  currentTask.reviewState === 'review' || currentTask.reviewState === 'needsFix'
                    ? '评审请在收件箱进行'
                    : undefined
                }
              />
            )}
          </CollapsibleTeamSection>
        ) : null}

        {/* Reference and delivery files. Empty sections stay hidden in the inbox. */}
        {!compactForInbox || relatedFileCount > 0 ? (
          <CollapsibleTeamSection
            title="相关文件"
            icon={<ImageIcon size={14} />}
            badge={relatedFileCount > 0 ? relatedFileCount : undefined}
            contentClassName="pl-2.5"
            headerClassName="-mx-6 w-[calc(100%+3rem)]"
            headerContentClassName="pl-6"
            defaultOpen={relatedFileCount > 0 && !compactForInbox}
          >
            {currentTask.sourceMessageId && currentTask.sourceMessage ? (
              <SourceMessageAttachments
                teamName={teamName}
                sourceMessageId={currentTask.sourceMessageId}
                sourceMessage={currentTask.sourceMessage}
              />
            ) : null}
            <TaskAttachments
              teamName={teamName}
              taskId={currentTask.id}
              attachments={currentTask.attachments ?? []}
            />
          </CollapsibleTeamSection>
        ) : null}

        {/* Changes */}
        {!compactForInbox && variant === 'team' && canShowTaskChanges && onViewChanges ? (
          <CollapsibleTeamSection
            key={`task-changes:${currentTask.id}`}
            title="文件变更"
            icon={<FileDiff size={14} />}
            badge={taskChangesFiles ? taskChangesFiles.length : undefined}
            headerExtra={
              changesSectionOpen ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="pointer-events-auto rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-section-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRefreshChanges();
                      }}
                      disabled={taskChangesLoading}
                      aria-label="刷新变更"
                    >
                      <RefreshCw
                        size={12}
                        className={taskChangesLoading ? 'animate-spin' : undefined}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">刷新</TooltipContent>
                </Tooltip>
              ) : null
            }
            contentClassName="pl-2.5"
            headerClassName="-mx-6 w-[calc(100%+3rem)]"
            headerContentClassName="pl-6"
            defaultOpen={false}
            onOpenChange={handleChangesSectionOpenChange}
          >
            {taskChangesLoading && (!taskChangesFiles || taskChangesFiles.length === 0) ? (
              <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                正在加载变更...
              </div>
            ) : taskChangesError ? (
              <p className="text-xs text-red-400">{taskChangesError}</p>
            ) : taskChangesFiles && taskChangesFiles.length > 0 ? (
              <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                {taskChangesFiles.map((file) => (
                  <div
                    key={file.filePath}
                    className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
                  >
                    <FileIcon
                      fileName={file.relativePath.split('/').pop() ?? file.relativePath}
                      className="size-3.5"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
                      onClick={() => {
                        handleClose();
                        onViewChanges(currentTask.id, file.filePath);
                      }}
                    >
                      {file.relativePath}
                    </button>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {file.linesAdded > 0 ? (
                        <span className="text-emerald-400">+{file.linesAdded}</span>
                      ) : null}
                      {file.linesRemoved > 0 ? (
                        <span className="text-red-400">-{file.linesRemoved}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                            onClick={() => {
                              handleClose();
                              onViewChanges(currentTask.id, file.filePath);
                            }}
                          >
                            <GitCompareArrows size={13} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">查看对比</TooltipContent>
                      </Tooltip>
                      {onOpenInEditor ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-border-emphasis)] hover:text-[var(--color-text)]"
                              onClick={() => onOpenInEditor(file.filePath)}
                            >
                              <SquarePen size={13} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">在编辑器中打开</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : changesSectionOpen ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                {currentTask.status === 'in_progress'
                  ? '任务正在执行，尚未产生文件变更'
                  : '该任务没有文件变更记录'}
              </p>
            ) : null}
          </CollapsibleTeamSection>
        ) : null}

        {/* Review info */}
        {kanbanTaskState?.reviewer || kanbanTaskState?.errorDescription ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {kanbanTaskState.reviewer ? (
                <span className="text-xs text-[var(--color-text-secondary)]">
                  评审人：{kanbanTaskState.reviewer}
                </span>
              ) : null}
              {kanbanTaskState.errorDescription ? (
                <span className="text-xs text-red-400">{kanbanTaskState.errorDescription}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Workflow History */}
        {!compactForInbox && currentTask.historyEvents && currentTask.historyEvents.length > 0 ? (
          <CollapsibleTeamSection
            title="流程历史"
            icon={<History size={14} />}
            badge={currentTask.historyEvents.length}
            contentClassName="pl-2.5"
            headerClassName="-mx-6 w-[calc(100%+3rem)]"
            headerContentClassName="pl-6"
            defaultOpen={false}
          >
            <WorkflowTimeline events={currentTask.historyEvents} memberColorMap={colorMap} />
          </CollapsibleTeamSection>
        ) : null}

        {/* 任务评论已移除：沟通统一走消息线程（收件箱） */}
        <div className="px-1 text-[11px] text-[var(--color-text-muted)] opacity-70">
          沟通已统一到消息线程；请在收件箱回复该任务的交付邮件。
        </div>
      </div>
    </LightboxLockProvider>
  );

  if (presentation === 'inline') {
    return (
      <div
        ref={setDialogContentEl}
        className="h-full min-w-0 overflow-y-auto bg-page-canvas px-6 py-5"
        data-task-detail-presentation="inline"
      >
        {detailContent}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && lightboxOpenRef.current) return;
        if (!v) handleClose();
      }}
    >
      <DialogContent
        ref={setDialogContentEl}
        className="sm:min-w-[500px] sm:max-w-4xl"
        onInteractOutside={(e) => {
          if (lightboxOpenRef.current) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (lightboxOpenRef.current) e.preventDefault();
        }}
        data-task-detail-presentation="dialog"
      >
        {detailContent}
      </DialogContent>
    </Dialog>
  );
};

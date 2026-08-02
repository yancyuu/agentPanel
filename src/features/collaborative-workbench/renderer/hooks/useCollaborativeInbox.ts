import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  getSnapshot as getActivityReadSnapshot,
  getUnreadCount,
  markActivityRead,
  subscribe as subscribeActivityRead,
} from '@renderer/services/taskActivityReadStorage';
import { useStore } from '@renderer/store';
import { getTaskInputMimeType, taskInputFileToBase64 } from '@renderer/utils/taskInputFiles';
import { useShallow } from 'zustand/react/shallow';

import {
  findReferencedTask,
  getAgentActivityItems,
  getGlobalTaskKey,
  getInboxTaskView,
  getTaskInboxActivityItems,
  type InboxTaskMessageProjection,
  type InboxTaskProjection,
  type InboxTaskView,
  projectInboxTaskMessages,
  projectInboxTasks,
} from '../utils/inboxProjection';

import type { ParsedTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import type { CreateTaskRequest, FeedbackAnchor, TaskRef, TeamTask } from '@shared/types';

async function uploadTaskInputFiles(
  files: File[],
  upload: (file: { name: string; type: string; base64: string }) => Promise<void>
): Promise<void> {
  const [file, ...remaining] = files;
  if (!file) return;
  await upload({
    name: file.name,
    type: getTaskInputMimeType(file),
    base64: await taskInputFileToBase64(file),
  });
  await uploadTaskInputFiles(remaining, upload);
}

export interface CollaborativeInboxState {
  view: InboxTaskView;
  setView: (view: InboxTaskView) => void;
  query: string;
  setQuery: (query: string) => void;
  teamFilter: string;
  setTeamFilter: (teamName: string) => void;
  ownerFilter: string;
  setOwnerFilter: (owner: string) => void;
  teamOptions: [string, string][];
  ownerOptions: string[];
  tasks: InboxTaskProjection[];
  messages: InboxTaskMessageProjection[];
  selectedKey: string | null;
  selectedTask: InboxTaskProjection | null;
  selectedMessageKey: string | null;
  selectedMessage: InboxTaskMessageProjection | null;
  selectTask: (key: string) => void;
  selectMessage: (key: string) => void;
  selectReferencedTask: (target: ParsedTaskLinkHref) => void;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  refresh: () => void;
  createTask: (
    teamName: string,
    request: CreateTaskRequest,
    inputFiles?: File[]
  ) => Promise<TeamTask>;
  updateOwner: (teamName: string, taskId: string, owner: string | null) => Promise<void>;
  approveTask: (teamName: string, taskId: string, force?: boolean) => Promise<void>;
  requestChanges: (
    teamName: string,
    taskId: string,
    comment?: string,
    taskRefs?: TaskRef[],
    anchor?: FeedbackAnchor
  ) => Promise<void>;
}

export function useCollaborativeInbox(): CollaborativeInboxState {
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    globalTasksError,
    fetchAllTasks,
    createTeamTask,
    saveTaskAttachment,
    startTaskByUser,
    updateTaskOwner,
    updateKanban,
    setInboxHasUnreadMessages,
  } = useStore(
    useShallow((state) => ({
      globalTasks: state.globalTasks,
      globalTasksLoading: state.globalTasksLoading,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksError: state.globalTasksError,
      fetchAllTasks: state.fetchAllTasks,
      createTeamTask: state.createTeamTask,
      saveTaskAttachment: state.saveTaskAttachment,
      startTaskByUser: state.startTaskByUser,
      updateTaskOwner: state.updateTaskOwner,
      updateKanban: state.updateKanban,
      setInboxHasUnreadMessages: state.setInboxHasUnreadMessages,
    }))
  );
  const readState = useSyncExternalStore(
    subscribeActivityRead,
    getActivityReadSnapshot,
    getActivityReadSnapshot
  );
  const [view, setView] = useState<InboxTaskView>('in_progress');
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedMessageKey, setSelectedMessageKey] = useState<string | null>(null);

  useEffect(() => {
    void fetchAllTasks();
  }, [fetchAllTasks]);

  const visibleBaseTasks = useMemo(
    () =>
      globalTasks.filter(
        (task) => task.status !== 'deleted' && !task.deletedAt && !task.teamDeleted
      ),
    [globalTasks]
  );

  const unreadCountByTask = useMemo(() => {
    const result: Record<string, number> = {};
    for (const task of visibleBaseTasks) {
      result[getGlobalTaskKey(task)] = getUnreadCount(
        readState,
        task.teamName,
        task.id,
        getAgentActivityItems(task)
      );
    }
    return result;
  }, [readState, visibleBaseTasks]);

  const tasks = useMemo(
    () =>
      projectInboxTasks({
        tasks: visibleBaseTasks,
        view,
        query,
        teamName: teamFilter,
        owner: ownerFilter,
        unreadCountByTask,
      }),
    [ownerFilter, query, teamFilter, unreadCountByTask, view, visibleBaseTasks]
  );

  const messages = useMemo(
    () =>
      projectInboxTaskMessages({
        tasks: visibleBaseTasks,
        query,
        teamName: teamFilter,
        unreadCountByTask,
      }),
    [query, teamFilter, unreadCountByTask, visibleBaseTasks]
  );

  useEffect(() => {
    setInboxHasUnreadMessages(messages.some((entry) => entry.unreadCount > 0));
  }, [messages, setInboxHasUnreadMessages]);

  useEffect(() => {
    if (messages.length === 0) {
      setSelectedMessageKey(null);
      return;
    }
    if (selectedMessageKey && messages.some((entry) => entry.key === selectedMessageKey)) return;
    setSelectedMessageKey(messages[0].key);
  }, [messages, selectedMessageKey]);

  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey && tasks.some((entry) => entry.key === selectedKey)) return;
    setSelectedKey(tasks[0].key);
  }, [selectedKey, tasks]);

  const teamOptions = useMemo(
    () =>
      Array.from(
        new Map(
          visibleBaseTasks.map((task) => [task.teamName, task.teamDisplayName] as const)
        ).entries()
      ).sort((a, b) => a[1].localeCompare(b[1], 'zh-CN')),
    [visibleBaseTasks]
  );

  const ownerOptions = useMemo(() => {
    const owners = new Set<string>();
    for (const task of visibleBaseTasks) {
      if (task.owner?.trim()) owners.add(task.owner.trim());
    }
    return Array.from(owners).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [visibleBaseTasks]);

  const refresh = useCallback(() => {
    void fetchAllTasks();
  }, [fetchAllTasks]);

  const markTaskFeedbackRead = useCallback(
    (key: string) => {
      const task = visibleBaseTasks.find((candidate) => getGlobalTaskKey(candidate) === key);
      if (!task) return;
      const activityIds = getTaskInboxActivityItems(task)
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id));
      markActivityRead(task.teamName, task.id, activityIds);
    },
    [visibleBaseTasks]
  );

  const selectTask = useCallback(
    (key: string) => {
      setSelectedKey(key);
      markTaskFeedbackRead(key);
    },
    [markTaskFeedbackRead]
  );

  const selectMessage = useCallback(
    (key: string) => {
      setSelectedMessageKey(key);
      markTaskFeedbackRead(key);
    },
    [markTaskFeedbackRead]
  );

  const selectReferencedTask = useCallback(
    (taskRef: ParsedTaskLinkHref) => {
      const target = findReferencedTask(visibleBaseTasks, taskRef);
      if (!target) return;
      setQuery('');
      setTeamFilter('all');
      setOwnerFilter('all');
      setView(getInboxTaskView(target));
      setSelectedKey(getGlobalTaskKey(target));
    },
    [visibleBaseTasks]
  );

  const createTask = useCallback(
    async (teamName: string, request: CreateTaskRequest, inputFiles: File[] = []) => {
      const hasInputFiles = inputFiles.length > 0;
      const task = await createTeamTask(teamName, {
        ...request,
        startImmediately: hasInputFiles ? false : request.startImmediately,
      });
      if (hasInputFiles) {
        await uploadTaskInputFiles(inputFiles, (file) =>
          saveTaskAttachment(teamName, task.id, file)
        );
        await startTaskByUser(teamName, task.id);
      }
      await fetchAllTasks();
      return task;
    },
    [createTeamTask, fetchAllTasks, saveTaskAttachment, startTaskByUser]
  );

  const updateOwner = useCallback(
    async (teamName: string, taskId: string, owner: string | null) => {
      await updateTaskOwner(teamName, taskId, owner);
    },
    [updateTaskOwner]
  );

  const approveTask = useCallback(
    async (teamName: string, taskId: string, force = false) => {
      await updateKanban(teamName, taskId, {
        op: 'set_column',
        column: 'approved',
        ...(force ? { force: true } : {}),
      });
      await fetchAllTasks();
    },
    [fetchAllTasks, updateKanban]
  );

  const requestChanges = useCallback(
    async (
      teamName: string,
      taskId: string,
      comment?: string,
      taskRefs?: TaskRef[],
      anchor?: FeedbackAnchor
    ) => {
      await updateKanban(teamName, taskId, {
        op: 'request_changes',
        comment,
        taskRefs,
        ...(anchor ? { anchor } : {}),
      });
      await fetchAllTasks();
    },
    [fetchAllTasks, updateKanban]
  );

  return {
    view,
    setView,
    query,
    setQuery,
    teamFilter,
    setTeamFilter,
    ownerFilter,
    setOwnerFilter,
    teamOptions,
    ownerOptions,
    tasks,
    messages,
    selectedKey,
    selectedTask: tasks.find((entry) => entry.key === selectedKey) ?? null,
    selectedMessageKey,
    selectedMessage: messages.find((entry) => entry.key === selectedMessageKey) ?? null,
    selectTask,
    selectMessage,
    selectReferencedTask,
    loading: globalTasksLoading,
    initialized: globalTasksInitialized,
    error: globalTasksError,
    refresh,
    createTask,
    updateOwner,
    approveTask,
    requestChanges,
  };
}

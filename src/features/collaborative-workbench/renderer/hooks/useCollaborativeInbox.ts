import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  getSnapshot as getCommentReadSnapshot,
  getUnreadCount,
  subscribe as subscribeCommentRead,
} from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import {
  getGlobalTaskKey,
  type InboxTaskProjection,
  type InboxTaskView,
  projectInboxTasks,
} from '../utils/inboxProjection';

export interface CollaborativeInboxState {
  view: InboxTaskView;
  setView(view: InboxTaskView): void;
  query: string;
  setQuery(query: string): void;
  teamFilter: string;
  setTeamFilter(teamName: string): void;
  ownerFilter: string;
  setOwnerFilter(owner: string): void;
  teamOptions: [string, string][];
  ownerOptions: string[];
  tasks: InboxTaskProjection[];
  selectedKey: string | null;
  selectedTask: InboxTaskProjection | null;
  selectTask(key: string): void;
  selectReferencedTask(taskId: string): void;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  refresh(): void;
  updateOwner(teamName: string, taskId: string, owner: string | null): Promise<void>;
}

export function useCollaborativeInbox(): CollaborativeInboxState {
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    globalTasksError,
    fetchAllTasks,
    updateTaskOwner,
  } = useStore(
    useShallow((state) => ({
      globalTasks: state.globalTasks,
      globalTasksLoading: state.globalTasksLoading,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksError: state.globalTasksError,
      fetchAllTasks: state.fetchAllTasks,
      updateTaskOwner: state.updateTaskOwner,
    }))
  );
  const readState = useSyncExternalStore(
    subscribeCommentRead,
    getCommentReadSnapshot,
    getCommentReadSnapshot
  );
  const [view, setView] = useState<InboxTaskView>('inbox');
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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
        task.comments ?? []
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

  const selectReferencedTask = useCallback(
    (taskId: string) => {
      const target = visibleBaseTasks.find((task) => task.id === taskId);
      if (!target) return;
      setQuery('');
      setTeamFilter('all');
      setOwnerFilter('all');
      setView(target.status === 'completed' ? 'completed' : 'inbox');
      setSelectedKey(getGlobalTaskKey(target));
    },
    [visibleBaseTasks]
  );

  const updateOwner = useCallback(
    async (teamName: string, taskId: string, owner: string | null) => {
      await updateTaskOwner(teamName, taskId, owner);
    },
    [updateTaskOwner]
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
    selectedKey,
    selectedTask: tasks.find((entry) => entry.key === selectedKey) ?? null,
    selectTask: setSelectedKey,
    selectReferencedTask,
    loading: globalTasksLoading,
    initialized: globalTasksInitialized,
    error: globalTasksError,
    refresh,
    updateOwner,
  };
}

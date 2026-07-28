import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleRun,
  UpdateSchedulePatch,
} from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('scheduleSlice');

// =============================================================================
// Slice Interface
// =============================================================================

export interface ScheduleSlice {
  // --- State ---
  schedules: Schedule[];
  schedulesLoading: boolean;
  schedulesError: string | null;
  scheduleRuns: Record<string, ScheduleRun[]>;
  scheduleRunsLoading: Record<string, boolean>;

  // --- Actions ---
  fetchSchedules(): Promise<void>;
  createSchedule(input: CreateScheduleInput): Promise<Schedule>;
  updateSchedule(id: string, patch: UpdateSchedulePatch): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  pauseSchedule(id: string): Promise<void>;
  resumeSchedule(id: string): Promise<void>;
  triggerNow(id: string): Promise<ScheduleRun>;
  fetchRunHistory(scheduleId: string): Promise<void>;

  /** Optimistic in-memory update from SCHEDULE_CHANGE events */
  applyScheduleChange(scheduleId: string): Promise<void>;

  /** Open a standalone Schedules tab (or focus existing) */
  openSchedulesTab(): void;

  /** Open the standalone task overview tab. */
  openTasksTab(): void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createScheduleSlice: StateCreator<AppState, [], [], ScheduleSlice> = (set, get) => ({
  schedules: [],
  schedulesLoading: false,
  schedulesError: null,
  scheduleRuns: {},
  scheduleRunsLoading: {},

  async fetchSchedules(): Promise<void> {
    // Guard: prevent concurrent fetches
    if (get().schedulesLoading) return;
    set({ schedulesLoading: true, schedulesError: null });

    try {
      const schedules = await api.schedules.list();
      set({ schedules, schedulesLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch schedules';
      logger.error('fetchSchedules failed:', message);
      set({ schedulesError: message, schedulesLoading: false });
    }
  },

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const schedule = await api.schedules.create(input);
    set((state) => ({ schedules: [...state.schedules, schedule] }));
    return schedule;
  },

  async updateSchedule(id: string, patch: UpdateSchedulePatch): Promise<Schedule> {
    const updated = await api.schedules.update(id, patch);
    set((state) => ({
      schedules: state.schedules.map((s) => (s.id === id ? updated : s)),
    }));
    return updated;
  },

  async deleteSchedule(id: string): Promise<void> {
    const previousSchedules = get().schedules;
    const previousRuns = get().scheduleRuns;
    set((state) => ({
      schedules: state.schedules.filter((s) => s.id !== id),
      scheduleRuns: Object.fromEntries(
        Object.entries(state.scheduleRuns).filter(([key]) => key !== id)
      ),
      schedulesError: null,
    }));
    try {
      await api.schedules.delete(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除计划失败';
      logger.error('deleteSchedule failed:', message);
      set({
        schedules: previousSchedules,
        scheduleRuns: previousRuns,
        schedulesError: message,
        schedulesLoading: false,
      });
      await get().fetchSchedules();
      throw err;
    }
    set((state) => ({
      schedules: state.schedules.filter((s) => s.id !== id),
      scheduleRuns: Object.fromEntries(
        Object.entries(state.scheduleRuns).filter(([key]) => key !== id)
      ),
      schedulesError: null,
    }));
    set({ schedulesLoading: false });
    await get().fetchSchedules();
    window.setTimeout(() => {
      void get().fetchSchedules();
    }, 800);
  },

  async pauseSchedule(id: string): Promise<void> {
    await api.schedules.pause(id);
    // Optimistic update — set status locally, then refetch for accuracy
    set((state) => ({
      schedules: state.schedules.map((s) =>
        s.id === id ? { ...s, status: 'paused' as const, updatedAt: new Date().toISOString() } : s
      ),
    }));
    // Refetch from cc-connect so enabled/next_run mirrors /api/v1/cron exactly.
    await get().fetchSchedules();
  },

  async resumeSchedule(id: string): Promise<void> {
    await api.schedules.resume(id);
    // Optimistic update
    set((state) => ({
      schedules: state.schedules.map((s) =>
        s.id === id ? { ...s, status: 'active' as const, updatedAt: new Date().toISOString() } : s
      ),
    }));
    // Refetch from cc-connect so enabled/next_run mirrors /api/v1/cron exactly.
    await get().fetchSchedules();
  },

  async triggerNow(id: string): Promise<ScheduleRun> {
    const now = new Date().toISOString();
    set((state) => ({
      scheduleRuns: {
        ...state.scheduleRuns,
        [id]: [
          {
            id: `pending-${Date.now()}`,
            scheduleId: id,
            teamName: state.schedules.find((schedule) => schedule.id === id)?.teamName ?? '',
            status: 'running',
            scheduledFor: now,
            startedAt: now,
            executionStartedAt: now,
            retryCount: 0,
            summary: '正在触发运行时...',
          },
          ...(state.scheduleRuns[id] ?? []),
        ],
      },
    }));
    const run = await api.schedules.triggerNow(id);
    set((state) => ({
      scheduleRuns: {
        ...state.scheduleRuns,
        [id]: [
          run,
          ...(state.scheduleRuns[id] ?? []).filter((entry) => !entry.id.startsWith('pending-')),
        ],
      },
    }));
    return run;
  },

  async fetchRunHistory(scheduleId: string): Promise<void> {
    if (get().scheduleRunsLoading[scheduleId]) return;
    set((state) => ({
      scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: true },
    }));

    try {
      const runs = await api.schedules.getRuns(scheduleId);
      set((state) => ({
        scheduleRuns: { ...state.scheduleRuns, [scheduleId]: runs },
        scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: false },
      }));
    } catch (err) {
      logger.error(`fetchRunHistory(${scheduleId}) failed:`, err);
      set((state) => ({
        scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: false },
      }));
    }
  },

  async applyScheduleChange(scheduleId: string): Promise<void> {
    try {
      // Refresh the specific schedule
      const schedule = await api.schedules.get(scheduleId);
      set((state) => {
        if (!schedule) {
          // Schedule was deleted
          return {
            schedules: state.schedules.filter((s) => s.id !== scheduleId),
          };
        }

        const exists = state.schedules.some((s) => s.id === scheduleId);
        return {
          schedules: exists
            ? state.schedules.map((s) => (s.id === scheduleId ? schedule : s))
            : [...state.schedules, schedule],
        };
      });

      // Also refresh runs if we have them loaded
      if (get().scheduleRuns[scheduleId]) {
        const runs = await api.schedules.getRuns(scheduleId);
        set((state) => ({
          scheduleRuns: { ...state.scheduleRuns, [scheduleId]: runs },
        }));
      }
    } catch (err) {
      logger.error('applyScheduleChange failed:', err);
    }
  },

  openSchedulesTab: () => {
    const state = get();
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existingTab = focusedPane?.tabs.find((tab) => tab.type === 'schedules');
    if (existingTab) {
      state.setActiveTab(existingTab.id);
      return;
    }

    state.openTab({
      type: 'schedules',
      label: '定时任务',
    });

    // Ensure schedules are fresh when opening
    void get().fetchSchedules();
  },

  openTasksTab: () => {
    const state = get();
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const existingTab = focusedPane?.tabs.find((tab) => tab.type === 'tasks');
    if (existingTab) {
      state.setActiveTab(existingTab.id);
      return;
    }

    state.openTab({
      type: 'tasks',
      label: '收件箱',
    });

    void get().fetchAllTasks();
    void get().fetchSchedules();
  },
});

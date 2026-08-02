import { useCallback, useEffect, useMemo, useState } from 'react';

import { recordRecentProjectOpenPaths } from '@features/recent-projects/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
} from '@renderer/store/slices/teamSlice';
import {
  getProjectSelectionResetState,
  getWorktreeNavigationState,
} from '@renderer/store/utils/stateResetHelpers';
import { formatRelativeTime, formatTokensCompact } from '@renderer/utils/formatters';
import { teamAvatarUrl } from '@renderer/utils/memberHelpers';
import {
  emitOpenHermitEvent,
  getCreateTeamFromProjectPath,
  OPEN_HERMIT_EVENTS,
} from '@renderer/utils/openHermitEvents';
import { buildTaskCountsByTeam, normalizePath } from '@renderer/utils/pathNormalize';
import { getBaseName } from '@renderer/utils/pathUtils';
import { nameColorSet } from '@renderer/utils/projectColor';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import {
  Bot,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  LayoutTemplate,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CreateTeamDialog } from './dialogs/CreateTeamDialog';
import { TeamEmptyState } from './TeamEmptyState';
import { EMPTY_TEAM_FILTER, TeamListFilterPopover } from './TeamListFilterPopover';
import {
  findTeamProjectSelectionTarget,
  resolveTeamProjectSelection,
  teamMatchesProjectSelection,
} from './teamProjectSelection';

import type { ActiveTeamRef, TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamListFilterState } from './TeamListFilterPopover';
import type {
  TeamCreateRequest,
  TeamSummary,
  TeamTemplateSource,
  TeamTemplateSummary,
} from '@shared/types';

function generateUniqueName(sourceName: string, existingNames: string[]): string {
  const base = sourceName.replace(/-\d+$/, '');
  const existing = new Set(existingNames);
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

type TeamStatus = 'active' | 'idle' | 'provisioning';

function folderName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

function formatTeamRoleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  const labels: Record<string, string> = {
    reviewer: '审查',
    architect: '架构',
    developer: '开发',
    engineer: '工程',
    tester: '测试',
    pm: '产品',
    'product-manager': '产品',
    designer: '设计',
  };
  return labels[normalized] ?? role;
}

function resolveTeamStatus(
  team: TeamSummary,
  teamName: string,
  currentProgress: ReturnType<typeof getCurrentProvisioningProgressForTeam>,
  leadActivityByTeam: Record<string, string>
): TeamStatus | null {
  if (
    currentProgress &&
    ['validating', 'spawning', 'configuring', 'assembling', 'finalizing', 'verifying'].includes(
      currentProgress.state
    )
  ) {
    return 'provisioning';
  }
  if (team.pendingCreate) return 'provisioning';
  if (team.deletedAt) return null;
  return leadActivityByTeam[teamName] === 'active' ? 'active' : 'idle';
}

function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const StatusBadge = ({ status }: { status: TeamStatus | null }): React.JSX.Element => {
  switch (status) {
    case 'active':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />
          工作中
        </span>
      );
    case 'idle':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--color-text-secondary)]">
          <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          可用
        </span>
      );
    case 'provisioning':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-amber-400">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden="true" />
          接入中
        </span>
      );
    default:
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--color-text-muted)]">
          <span
            className="size-1.5 rounded-full bg-[var(--color-text-muted)] opacity-50"
            aria-hidden="true"
          />
          配置异常
        </span>
      );
  }
};

const PendingDeleteBadge = (): React.JSX.Element => (
  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
    待重启生效
  </span>
);

const TeamListSkeleton = (): React.JSX.Element => (
  <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
    {Array.from({ length: 7 }).map((_, index) => (
      <div
        key={index}
        className="flex min-h-16 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
      >
        <div className="skeleton-shimmer size-9 rounded-lg bg-[var(--skeleton-base)]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="skeleton-shimmer h-3 w-32 rounded bg-[var(--skeleton-base)]" />
          <div className="skeleton-shimmer h-2.5 w-2/3 rounded bg-[var(--skeleton-base-dim)]" />
        </div>
        <div className="skeleton-shimmer hidden h-3 w-24 rounded bg-[var(--skeleton-base-dim)] md:block" />
      </div>
    ))}
  </div>
);

export const TeamListView = (): React.JSX.Element => {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSources, setTemplateSources] = useState<TeamTemplateSource[]>([]);
  const [teamTemplates, setTeamTemplates] = useState<TeamTemplateSummary[]>([]);
  const [newTemplateSourceUrl, setNewTemplateSourceUrl] = useState('');
  const [copyData, setCopyData] = useState<TeamCopyData | null>(null);
  const [createDialogProjectPath, setCreateDialogProjectPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<TeamListFilterState>(EMPTY_TEAM_FILTER);
  const [deletingTeamName, setDeletingTeamName] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [statsWarmupRequested, setStatsWarmupRequested] = useState(false);
  const {
    teams,
    teamsLoading,
    teamsError,
    fetchTeams,
    openTeamTab,
    deleteTeam,
    restoreTeam,
    permanentlyDeleteTeam,
    projects,
    globalTasks,
    fetchAllTasks,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedProjectId,
    activeProjectId,
    branchByPath,
  } = useStore(
    useShallow((s) => ({
      teams: s.teams,
      teamsLoading: s.teamsLoading,
      teamsError: s.teamsError,
      fetchTeams: s.fetchTeams,
      openTeamTab: s.openTeamTab,
      deleteTeam: s.deleteTeam,
      restoreTeam: s.restoreTeam,
      permanentlyDeleteTeam: s.permanentlyDeleteTeam,
      projects: s.projects,
      globalTasks: s.globalTasks,
      fetchAllTasks: s.fetchAllTasks,
      repositoryGroups: s.repositoryGroups,
      selectedRepositoryId: s.selectedRepositoryId,
      selectedWorktreeId: s.selectedWorktreeId,
      selectedProjectId: s.selectedProjectId,
      activeProjectId: s.activeProjectId,
      branchByPath: s.branchByPath,
    }))
  );
  const {
    createTeam,
    provisioningErrorByTeam,
    clearProvisioningError,
    provisioningRuns,
    provisioningSnapshotByTeam,
    currentProvisioningRunIdByTeam,
    leadActivityByTeam,
  } = useStore(
    useShallow((s) => ({
      createTeam: s.createTeam,
      provisioningErrorByTeam: s.provisioningErrorByTeam,
      clearProvisioningError: s.clearProvisioningError,
      provisioningRuns: s.provisioningRuns,
      provisioningSnapshotByTeam: s.provisioningSnapshotByTeam,
      currentProvisioningRunIdByTeam: s.currentProvisioningRunIdByTeam,
      leadActivityByTeam: s.leadActivityByTeam,
    }))
  );
  const canCreate = true;
  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );

  /** Team names currently in active provisioning — prevents name conflicts in create dialog. */
  const provisioningTeamNames = useMemo(() => {
    return Object.keys(currentProvisioningRunIdByTeam).filter((teamName) =>
      isTeamProvisioningActive(provisioningState, teamName)
    );
  }, [currentProvisioningRunIdByTeam, provisioningState]);

  /** Merge real teams with synthetic launching cards for active provisioning. */
  const teamsWithProvisioning = useMemo(() => {
    const existingNames = new Set(teams.map((t) => t.teamName));
    const synthetic = provisioningTeamNames
      .filter((name) => !existingNames.has(name) && provisioningSnapshotByTeam[name])
      .map((name) => provisioningSnapshotByTeam[name]);
    return synthetic.length > 0 ? [...teams, ...synthetic] : teams;
  }, [teams, provisioningTeamNames, provisioningSnapshotByTeam]);

  const teamListStats = useMemo(() => {
    const activeTeams = teamsWithProvisioning.filter((team) => !team.deletedAt);
    return activeTeams.reduce(
      (acc, team) => {
        acc.teams += 1;
        if (!team.pendingCreate) acc.running += 1;
        acc.sessions += team.stats?.sessions ?? 0;
        acc.messages += team.stats?.messages ?? 0;
        acc.tokens += team.stats?.tokens ?? 0;
        acc.durationMs += team.stats?.durationMs ?? 0;
        return acc;
      },
      { teams: 0, running: 0, sessions: 0, messages: 0, tokens: 0, durationMs: 0 }
    );
  }, [teamsWithProvisioning]);

  useEffect(() => {
    if (statsWarmupRequested || teamsLoading || teamsWithProvisioning.length === 0) return;
    if (teamListStats.sessions > 0 || teamListStats.messages > 0 || teamListStats.tokens > 0)
      return;

    setStatsWarmupRequested(true);
    const firstRefresh = window.setTimeout(() => void fetchTeams(), 1200);
    const secondRefresh = window.setTimeout(() => void fetchTeams(), 3500);
    return () => {
      window.clearTimeout(firstRefresh);
      window.clearTimeout(secondRefresh);
    };
  }, [fetchTeams, statsWarmupRequested, teamListStats, teamsLoading, teamsWithProvisioning.length]);

  // Fetch alive teams on mount and when teams list changes
  useEffect(() => {
    let cancelled = false;
    const fetchAlive = async (): Promise<void> => {
      try {
        const list = await api.teams.aliveList();
        if (!cancelled) setAliveTeams(list);
      } catch {
        // best-effort
      }
    };
    void fetchAlive();
    return () => {
      cancelled = true;
    };
  }, [teams]);

  // Refresh alive teams when opening the create dialog so conflict warning is accurate.
  useEffect(() => {
    if (!showCreateDialog) return;
    let cancelled = false;
    void api.teams
      .aliveList()
      .then((list) => {
        if (!cancelled) setAliveTeams(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showCreateDialog]);

  const currentProjectSelection = useMemo(
    () =>
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId,
        selectedWorktreeId,
        selectedProjectId,
        activeProjectId,
      }),
    [
      repositoryGroups,
      projects,
      selectedRepositoryId,
      selectedWorktreeId,
      selectedProjectId,
      activeProjectId,
    ]
  );
  const currentProjectPath = currentProjectSelection.projectPath;
  const effectiveCreateProjectPath = createDialogProjectPath ?? currentProjectPath;

  useEffect(() => {
    const openCreateDialogFromProject = (event: Event): void => {
      const projectPath = getCreateTeamFromProjectPath(event);
      if (!projectPath) return;

      setCopyData(null);
      setCreateDialogProjectPath(projectPath);
      setShowCreateDialog(true);
    };

    window.addEventListener(OPEN_HERMIT_EVENTS.createTeamFromProject, openCreateDialogFromProject);
    return () => {
      window.removeEventListener(
        OPEN_HERMIT_EVENTS.createTeamFromProject,
        openCreateDialogFromProject
      );
    };
  }, []);

  const filteredTeams = useMemo<TeamSummary[]>(() => {
    let result = teamsWithProvisioning;

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (t) =>
          t.teamName.toLowerCase().includes(q) ||
          t.displayName.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      );
    }

    if (filter.selectedStatuses.size > 0) {
      result = result.filter((t) => {
        const status = resolveTeamStatus(
          t,
          t.teamName,
          getCurrentProvisioningProgressForTeam(provisioningState, t.teamName),
          leadActivityByTeam
        );
        const isRunning = status !== null;
        return filter.selectedStatuses.has('running') && isRunning;
      });
    }

    const matchesCurrentProject = currentProjectPath
      ? (team: TeamSummary): boolean => teamMatchesProjectSelection(team, currentProjectPath)
      : null;

    result = [...result].sort((a, b) => {
      // 0. Project-level system manager is a namespace node, not a regular worker team.
      const managerA = a.teamName === SYSTEM_MANAGER_TEAM_NAME ? 0 : 1;
      const managerB = b.teamName === SYSTEM_MANAGER_TEAM_NAME ? 0 : 1;
      if (managerA !== managerB) return managerA - managerB;

      // 1. Teams related to the selected project are prioritized next.
      if (matchesCurrentProject) {
        const projectA = matchesCurrentProject(a) ? 0 : 1;
        const projectB = matchesCurrentProject(b) ? 0 : 1;
        if (projectA !== projectB) return projectA - projectB;
      }

      // 2. Most recently active teams first.
      const tsA = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tsB = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      if (tsA !== tsB) return tsB - tsA;

      // 3. Fallback: alphabetical by team name for deterministic order.
      // Availability is intentionally not part of ordering; stable rows are easier to scan.
      return a.teamName.localeCompare(b.teamName);
    });

    return result;
  }, [
    teamsWithProvisioning,
    searchQuery,
    currentProjectPath,
    filter,
    provisioningState,
    leadActivityByTeam,
  ]);

  const handleProjectSelectionChange = useCallback(
    (projectPath: string | null): void => {
      if (!projectPath) {
        useStore.setState(getProjectSelectionResetState());
        return;
      }

      const target = findTeamProjectSelectionTarget(repositoryGroups, projects, projectPath);
      if (!target) {
        console.warn('Unable to resolve selected team project path:', projectPath);
        return;
      }

      if (target.kind === 'grouped') {
        useStore.setState(getWorktreeNavigationState(target.repositoryId, target.worktreeId));
        void useStore.getState().fetchSessionsInitial(target.worktreeId);
        recordRecentProjectOpenPaths([projectPath]);
        return;
      }

      useStore.getState().selectProject(target.projectId);
      recordRecentProjectOpenPaths([projectPath]);
    },
    [projects, repositoryGroups]
  );

  // Fetch branches once for all visible team project paths (no live polling)
  const teamPaths = useMemo(
    () => filteredTeams.map((t) => t.projectPath?.trim()).filter(Boolean) as string[],
    [filteredTeams]
  );
  useBranchSync(teamPaths, { live: false });

  const handleDeleteTeam = useCallback(
    (teamName: string, isDraft: boolean, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        const teamDisplayName =
          teams.find((team) => team.teamName === teamName)?.displayName || teamName;
        if (isDraft) {
          const confirmed = await confirm({
            title: '删除草稿',
            message: `确定删除草稿数字员工“${teamDisplayName}”吗？此操作无法撤销。`,
            confirmLabel: '删除',
            cancelLabel: '取消',
            variant: 'danger',
          });
          if (confirmed) {
            void api.teams.deleteDraft(teamName).catch(() => {});
          }
          return;
        }
        const confirmed = await confirm({
          title: '删除数字员工',
          message: `确定删除数字员工”${teamDisplayName}”吗？此操作会移除本地配置数据。`,
          confirmLabel: '删除',
          cancelLabel: '取消',
          variant: 'danger',
        });
        if (confirmed) {
          setDeletingTeamName(teamName);
          try {
            const result = await deleteTeam(teamName);
            if (result.restartRequired) {
              await api.ccSettings.restart();
            }
            await fetchTeams();
          } catch (err) {
            console.error('Failed to delete team:', err);
          } finally {
            setDeletingTeamName(null);
          }
        }
      })();
    },
    [deleteTeam, teams, fetchTeams]
  );

  const handleRestoreTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          await restoreTeam(teamName);
        } catch {
          // error via store
        }
      })();
    },
    [restoreTeam]
  );

  const handlePermanentlyDeleteTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        const teamDisplayName =
          teams.find((team) => team.teamName === teamName)?.displayName || teamName;
        const confirmed = await confirm({
          title: '永久删除',
          message: `确定永久删除 Agent“${teamDisplayName}”吗？所有数据都将丢失。`,
          confirmLabel: '永久删除',
          cancelLabel: '取消',
          variant: 'danger',
        });
        if (confirmed) {
          try {
            await permanentlyDeleteTeam(teamName);
          } catch {
            // error via store
          }
        }
      })();
    },
    [permanentlyDeleteTeam, teams]
  );

  const openCreateDialog = useCallback((): void => {
    setCreateDialogProjectPath(null);
    setShowCreateDialog(true);
  }, []);

  const handleCopyTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          const data = await api.teams.getData(teamName);
          const existingNames = teams.map((t) => t.teamName);
          const uniqueName = generateUniqueName(teamName, existingNames);
          setCopyData({
            teamName: uniqueName,
            description: data.config.description,
            color: data.config.color,
          });
          openCreateDialog();
        } catch {
          // silently ignore — team data may be unavailable
        }
      })();
    },
    [openCreateDialog, teams]
  );

  useEffect(() => {
    void fetchTeams();
    void fetchAllTasks();
  }, [fetchTeams, fetchAllTasks]);

  useEffect(() => {
    const refresh = (): void => {
      void fetchTeams();
      void fetchAllTasks();
    };
    window.addEventListener(OPEN_HERMIT_EVENTS.runtimeRestarted, refresh);
    window.addEventListener(OPEN_HERMIT_EVENTS.teamsChanged, refresh);
    return () => {
      window.removeEventListener(OPEN_HERMIT_EVENTS.runtimeRestarted, refresh);
      window.removeEventListener(OPEN_HERMIT_EVENTS.teamsChanged, refresh);
    };
  }, [fetchTeams, fetchAllTasks]);

  const taskCountsByTeam = useMemo(() => buildTaskCountsByTeam(globalTasks), [globalTasks]);

  const activeTeams = useMemo<ActiveTeamRef[]>(() => {
    const aliveSet = new Set(aliveTeams);
    return teams
      .filter((t) => aliveSet.has(t.teamName) && t.projectPath)
      .map((t) => ({
        teamName: t.teamName,
        displayName: t.displayName,
        projectPath: t.projectPath!,
      }));
  }, [teams, aliveTeams]);

  const handleCreateDialogClose = useCallback(() => {
    setShowCreateDialog(false);
    setCopyData(null);
    setCreateDialogProjectPath(null);
  }, []);

  const loadTemplates = useCallback(async (refresh = false): Promise<void> => {
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const snapshot = refresh
        ? await api.teams.refreshTemplateSources()
        : await api.teams.listTemplateSources();
      setTemplateSources(snapshot.sources);
      setTeamTemplates(snapshot.templates);
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '读取数字员工模板失败');
    } finally {
      setTemplateLoading(false);
    }
  }, []);

  const openTemplateDialog = useCallback((): void => {
    setShowTemplateDialog(true);
    void loadTemplates(false);
  }, [loadTemplates]);

  const handleAddTemplateSource = useCallback(async (): Promise<void> => {
    const url = newTemplateSourceUrl.trim();
    if (!url) return;
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const sourceId = url
        .replace(/\.git$/, '')
        .split(/[/:]/)
        .filter(Boolean)
        .slice(-2)
        .join('-')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-');
      const nextSources: TeamTemplateSource[] = [
        ...templateSources,
        {
          id: sourceId || `source-${Date.now().toString(36)}`,
          name: sourceId || '自定义模板源',
          url,
          enabled: true,
          branch: 'main',
        },
      ];
      const saved = await api.teams.saveTemplateSources(nextSources);
      setTemplateSources(saved.sources);
      const refreshed = await api.teams.refreshTemplateSources();
      setTemplateSources(refreshed.sources);
      setTeamTemplates(refreshed.templates);
      setNewTemplateSourceUrl('');
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : '添加模板源失败');
    } finally {
      setTemplateLoading(false);
    }
  }, [newTemplateSourceUrl, templateSources]);

  const handleRemoveTemplateSource = useCallback(
    async (source: TeamTemplateSource): Promise<void> => {
      if (source.isDefault) return;
      setTemplateLoading(true);
      setTemplateError(null);
      try {
        const saved = await api.teams.saveTemplateSources(
          templateSources.filter((item) => item.id !== source.id)
        );
        setTemplateSources(saved.sources);
        setTeamTemplates(saved.templates);
      } catch (error) {
        setTemplateError(error instanceof Error ? error.message : '删除模板源失败');
      } finally {
        setTemplateLoading(false);
      }
    },
    [templateSources]
  );

  const handleUseTemplate = useCallback(
    (template: TeamTemplateSummary): void => {
      setCopyData({
        teamName: generateUniqueName(
          template.templateId,
          teams.map((team) => team.teamName)
        ),
        description: template.description,
        color: template.color,
        providerId: template.providerId ?? 'anthropic',
        model: template.model,
        effort: template.effort,
        fastMode: template.fastMode,
        limitContext: template.limitContext,
        skipPermissions: template.skipPermissions,
        templateSourceId: template.sourceId,
        templateDirectoryId: template.templateDirectoryId,
      });
      setShowTemplateDialog(false);
      openCreateDialog();
    },
    [openCreateDialog, teams]
  );

  const handleCreateSubmit = useCallback(
    async (request: TeamCreateRequest) => {
      await createTeam(request);
      await Promise.all([fetchTeams(), fetchAllTasks()]);
      emitOpenHermitEvent(OPEN_HERMIT_EVENTS.teamsChanged);
      window.setTimeout(() => {
        void fetchTeams();
        void fetchAllTasks();
      }, 1200);
    },
    [createTeam, fetchAllTasks, fetchTeams]
  );

  const createDialogElement = (
    <CreateTeamDialog
      open={showCreateDialog}
      canCreate={canCreate}
      provisioningErrorsByTeam={provisioningErrorByTeam}
      clearProvisioningError={clearProvisioningError}
      existingTeamNames={teams.map((t) => t.teamName)}
      existingBindProjects={teams.map((t) => t.bindProject).filter(Boolean) as string[]}
      existingDisplayNames={teams.map((t) => t.displayName).filter(Boolean)}
      provisioningTeamNames={provisioningTeamNames}
      activeTeams={activeTeams}
      initialData={copyData ?? undefined}
      defaultProjectPath={effectiveCreateProjectPath}
      onClose={handleCreateDialogClose}
      onCreate={handleCreateSubmit}
      onOpenTeam={openTeamTab}
    />
  );

  const templateDialogElement = (
    <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm">从模板创建智能体</DialogTitle>
          <DialogDescription className="text-xs">
            从数字员工模板仓库读取可复用配置。默认源为 AgentCLI 官方模板
            https://github.com/yancyuu/HermitTeams.git，仓库根目录下含有 hermit-team.json
            的一级目录会被识别为模板。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <label
                htmlFor="team-template-source-url"
                className="text-[11px] font-medium text-[var(--color-text-secondary)]"
              >
                添加模板源
              </label>
              <Input
                id="team-template-source-url"
                className="h-8 text-xs"
                value={newTemplateSourceUrl}
                onChange={(event) => setNewTemplateSourceUrl(event.target.value)}
                placeholder="https://github.com/yancyuu/HermitTeams.git"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={templateLoading || !newTemplateSourceUrl.trim()}
              onClick={() => void handleAddTemplateSource()}
            >
              添加并刷新
            </Button>
          </div>
          {templateSources.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {templateSources.map((source) => (
                <span
                  key={source.id}
                  className="inline-flex max-w-full items-center gap-1 rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                  title={source.url}
                >
                  <span className="max-w-44 truncate">
                    {source.name}
                    {source.isDefault ? ' · 默认' : ''}
                    {source.lastError ? ' · 同步失败' : ''}
                  </span>
                  {!source.isDefault ? (
                    <button
                      type="button"
                      className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-300"
                      aria-label={`删除模板源 ${source.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleRemoveTemplateSource(source);
                      }}
                    >
                      <Trash2 size={10} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-text-muted)]">
            {teamTemplates.length > 0 ? `已发现 ${teamTemplates.length} 个模板` : '暂无模板缓存'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={templateLoading}
            onClick={() => void loadTemplates(true)}
          >
            <Download size={12} className={templateLoading ? 'animate-pulse' : ''} />
            {templateLoading ? '刷新中...' : '刷新模板源'}
          </Button>
        </div>
        {templateError ? (
          <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {templateError}
          </p>
        ) : null}
        <div className="max-h-[56vh] space-y-2 overflow-auto pr-1">
          {teamTemplates.map((template) => (
            <div
              key={`${template.sourceId}:${template.templateId}`}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-[var(--color-text)]">
                      {template.displayName}
                    </h3>
                    <span className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {template.templateId}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                    {template.description || '暂无描述'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {template.members.map((member) => (
                      <span
                        key={member.name}
                        className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]"
                      >
                        {member.name}
                        {member.role ? ` · ${formatTeamRoleLabel(member.role)}` : ''}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    来源：{template.sourceName}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-7 shrink-0 bg-[var(--color-accent)] text-xs text-white hover:bg-[var(--color-accent)] hover:opacity-90"
                  onClick={() => handleUseTemplate(template)}
                >
                  使用模板
                </Button>
              </div>
            </div>
          ))}
          {!templateLoading && teamTemplates.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
              没有发现模板。请刷新模板源，或确认仓库根目录下存在 */hermit-team.json。
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );

  const renderHeader = (): React.JSX.Element => (
    <header className="mb-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-[var(--color-text-secondary)]" aria-hidden="true" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--color-text)]">Agent</h1>
            <span className="rounded-md bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--color-text-muted)]">
              {teamListStats.teams}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            管理数字员工、运行时与本地工作空间。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={openTemplateDialog}>
            <LayoutTemplate size={13} aria-hidden="true" />
            从模板创建
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)] hover:opacity-90"
            disabled={!canCreate}
            onClick={openCreateDialog}
          >
            <Plus size={13} aria-hidden="true" />
            创建智能体
          </Button>
        </div>
      </div>

      {teamsWithProvisioning.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-[var(--color-border)] py-2 text-xs text-[var(--color-text-muted)]">
          <span>
            <strong className="font-medium text-[var(--color-text)]">
              {teamListStats.running}
            </strong>{' '}
            个可用
          </span>
          <span>
            <strong className="font-medium text-[var(--color-text)]">
              {teamListStats.sessions}
            </strong>{' '}
            个会话
          </span>
          <span>
            <strong className="font-medium text-[var(--color-text)]">
              {teamListStats.messages}
            </strong>{' '}
            条消息
          </span>
          <span>
            <strong className="font-medium text-[var(--color-text)]">
              {formatTokensCompact(teamListStats.tokens)}
            </strong>{' '}
            tokens
          </span>
          <span>
            <strong className="font-medium text-[var(--color-text)]">
              {formatDurationShort(teamListStats.durationMs)}
            </strong>{' '}
            累计耗时
          </span>
        </div>
      ) : null}

      {teamsWithProvisioning.length > 0 ? (
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label="搜索 Agent"
              placeholder="搜索数字员工或描述"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <TeamListFilterPopover
            filter={filter}
            selectedProjectPath={currentProjectPath}
            teams={teamsWithProvisioning}
            aliveTeams={teamsWithProvisioning
              .filter((team) => !team.deletedAt && !team.pendingCreate)
              .map((team) => team.teamName)}
            onFilterChange={setFilter}
            onProjectChange={handleProjectSelectionChange}
          />
        </div>
      ) : null}
    </header>
  );

  const renderContent = (): React.JSX.Element => {
    if (teamsLoading) return <TeamListSkeleton />;

    if (teamsError) {
      return (
        <div className="flex min-h-64 items-center justify-center rounded-xl border border-[var(--color-border)] p-6">
          <div className="text-center" role="alert">
            <p className="text-sm font-medium text-red-400">Agent 加载失败</p>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">{teamsError}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => void fetchTeams()}>
              重试
            </Button>
          </div>
        </div>
      );
    }

    if (teamsWithProvisioning.length === 0) {
      return (
        <TeamEmptyState
          canCreate={canCreate}
          onCreateTeam={openCreateDialog}
          onSelectHarness={() => openCreateDialog()}
        />
      );
    }

    const hasActiveFilters = filter.selectedStatuses.size > 0;
    if (filteredTeams.length === 0 && (searchQuery.trim() || hasActiveFilters)) {
      return (
        <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
          没有匹配当前筛选条件的 Agent
        </div>
      );
    }

    const activeFiltered = filteredTeams.filter((team) => !team.deletedAt);
    const deletedFiltered = filteredTeams.filter((team) => team.deletedAt);

    const renderActiveRow = (team: TeamSummary): React.JSX.Element => {
      const status = resolveTeamStatus(
        team,
        team.teamName,
        getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
        leadActivityByTeam
      );
      const teamColorSet = team.color
        ? getTeamColorSet(team.color)
        : nameColorSet(team.displayName);
      const isDeleting = deletingTeamName === team.teamName;
      const isSystemManager = team.teamName === SYSTEM_MANAGER_TEAM_NAME;
      const taskCounts = taskCountsByTeam.get(team.teamName) ?? {
        pending: 0,
        inProgress: 0,
        completed: 0,
      };
      const openTasks = taskCounts.pending + taskCounts.inProgress;
      const branch = team.projectPath ? branchByPath[normalizePath(team.projectPath)] : null;

      return (
        <div
          key={team.teamName}
          role="listitem"
          className="group relative grid min-h-[72px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--color-border)] px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(260px,1.45fr)_minmax(120px,.65fr)_minmax(150px,.8fr)_minmax(130px,.7fr)_104px] md:px-4"
        >
          <button
            type="button"
            className="absolute inset-0 rounded-none text-left outline-none transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:cursor-wait"
            aria-label={`打开 Agent ${team.displayName}`}
            disabled={isDeleting}
            onClick={() => openTeamTab(team.teamName, team.projectPath)}
          />

          <div className="pointer-events-none relative z-[1] flex min-w-0 items-center gap-3">
            <img
              src={teamAvatarUrl(team.teamName, team.displayName)}
              alt=""
              className="size-9 shrink-0 rounded-lg border bg-[var(--color-surface-raised)]"
              style={{ borderColor: `${teamColorSet.border}66` }}
              draggable={false}
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--color-text)]">
                  {team.displayName}
                </span>
                {isSystemManager ? (
                  <span className="rounded bg-[var(--color-accent-soft)] px-1 py-px text-[9px] font-medium text-[var(--color-accent)]">
                    系统
                  </span>
                ) : null}
                {team.isExternallyReachable ? (
                  <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-500">
                    可对外
                  </span>
                ) : null}
                {team.pendingDelete || team.restartRequired ? <PendingDeleteBadge /> : null}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <span className="shrink-0 font-mono">@{team.teamName}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{team.description || '暂无描述'}</span>
              </div>
            </div>
          </div>

          <div className="pointer-events-none relative z-[1] hidden min-w-0 md:block">
            <StatusBadge status={status} />
            <p className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]">
              {openTasks > 0 ? `${openTasks} 个待处理任务` : `${taskCounts.completed} 个已完成任务`}
            </p>
          </div>

          <div className="pointer-events-none relative z-[1] hidden min-w-0 md:block">
            <p className="flex min-w-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
              <FolderOpen
                size={11}
                className="shrink-0 text-[var(--color-text-muted)]"
                aria-hidden="true"
              />
              <span className="truncate" title={team.projectPath}>
                {team.projectPath ? folderName(team.projectPath) : '未绑定项目'}
              </span>
            </p>
            {branch ? (
              <p
                className="mt-1 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
                title={branch}
              >
                <GitBranch size={10} aria-hidden="true" />
                <span className="truncate">{branch}</span>
              </p>
            ) : null}
          </div>

          <div className="pointer-events-none relative z-[1] hidden min-w-0 text-xs text-[var(--color-text-muted)] md:block">
            <p>{team.lastActivity ? formatRelativeTime(team.lastActivity) : '暂无活动'}</p>
            <p className="mt-1 truncate text-[10px]">
              {team.stats && (team.stats.sessions > 0 || team.stats.messages > 0)
                ? `${team.stats.sessions} 会话 · ${team.stats.messages} 消息`
                : '暂无使用记录'}
            </p>
          </div>

          <div className="relative z-20 flex shrink-0 items-center justify-end gap-0.5">
            <span className="mr-1 md:hidden">
              <StatusBadge status={status} />
            </span>
            {isDeleting ? (
              <Loader2
                size={14}
                className="animate-spin text-[var(--color-text-muted)]"
                aria-label="删除中"
              />
            ) : null}
            {!team.pendingCreate && !isSystemManager ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                    aria-label={`复制 Agent ${team.displayName}`}
                    onClick={(event) => handleCopyTeam(team.teamName, event)}
                  >
                    <Copy size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">复制 Agent</TooltipContent>
              </Tooltip>
            ) : null}
            {team.teamName !== 'default' && team.teamName !== 'my-project' && !isSystemManager ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-8 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    aria-label={`删除 Agent ${team.displayName}`}
                    onClick={(event) =>
                      handleDeleteTeam(team.teamName, !!team.pendingCreate, event)
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">删除 Agent</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      );
    };

    return (
      <div className="space-y-5">
        {activeFiltered.length > 0 ? (
          <section aria-label="Agent 列表">
            <div className="hidden grid-cols-[minmax(260px,1.45fr)_minmax(120px,.65fr)_minmax(150px,.8fr)_minmax(130px,.7fr)_104px] gap-3 border-x border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] md:grid">
              <span>Agent</span>
              <span>运行状态</span>
              <span>项目</span>
              <span>最近活动</span>
              <span className="w-[104px] text-right">操作</span>
            </div>
            <div
              role="list"
              className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] md:rounded-t-none"
            >
              {activeFiltered.map(renderActiveRow)}
            </div>
          </section>
        ) : null}

        {deletedFiltered.length > 0 ? (
          <section aria-labelledby="deleted-teams-heading">
            <div className="mb-2 flex items-center justify-between">
              <h2
                id="deleted-teams-heading"
                className="text-xs font-medium text-[var(--color-text-secondary)]"
              >
                已删除 Agent
              </h2>
              <span className="text-xs text-[var(--color-text-muted)]">
                {deletedFiltered.length}
              </span>
            </div>
            <div
              role="list"
              className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] opacity-75"
            >
              {deletedFiltered.map((team) => (
                <div
                  key={team.teamName}
                  role="listitem"
                  className="flex min-h-14 items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0"
                >
                  <img
                    src={teamAvatarUrl(team.teamName, team.displayName)}
                    alt=""
                    className="size-8 rounded-lg grayscale"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--color-text)]">
                      {team.displayName}
                    </p>
                    <p className="truncate text-xs text-[var(--color-text-muted)]">
                      @{team.teamName} · 已删除
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={(event) => handleRestoreTeam(team.teamName, event)}
                      aria-label={`恢复 Agent ${team.displayName}`}
                    >
                      <RotateCcw size={13} />
                      恢复
                    </Button>
                    <button
                      type="button"
                      className="inline-flex size-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                      onClick={(event) => handlePermanentlyDeleteTeam(team.teamName, event)}
                      aria-label={`永久删除 Agent ${team.displayName}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
        {renderContent()}
        {templateDialogElement}
        {createDialogElement}
      </div>
    </TooltipProvider>
  );
};

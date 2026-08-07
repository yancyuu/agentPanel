import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { useStore } from '@renderer/store';
import { SYSTEM_MANAGER_DISPLAY_NAME, SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import { ArrowUp, ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { WorkspaceFileEntry, WorkspaceListResponse } from '@shared/types/editor';

function getRelativePath(currentDir: string, rootPath: string): string {
  if (!currentDir || currentDir === rootPath) return '';
  return currentDir.slice(rootPath.endsWith('/') ? rootPath.length : rootPath.length + 1);
}

function buildBreadcrumb(rootPath: string, currentDir: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [{ label: '根目录', path: rootPath }];
  const rel = getRelativePath(currentDir, rootPath);
  if (!rel) return crumbs;

  const parts = rel.split('/');
  let accum = rootPath.endsWith('/') ? rootPath : rootPath + '/';
  for (const part of parts) {
    accum += part + '/';
    crumbs.push({ label: part, path: accum.slice(0, -1) });
  }
  return crumbs;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// TeamWorkspace — single team's file browser section
// ---------------------------------------------------------------------------

interface TeamWorkspaceProps {
  teamDisplayName: string;
  projectPath: string;
  isExpanded: boolean;
  onToggle: () => void;
  onFileClick: (filePath: string) => void;
}

function joinWorkspacePath(basePath: string, entryName: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  const normalizedBase =
    basePath.endsWith('/') || basePath.endsWith('\\') ? basePath.slice(0, -1) : basePath;
  return `${normalizedBase}${separator}${entryName}`;
}

const TeamWorkspace = ({
  teamDisplayName,
  projectPath,
  isExpanded,
  onToggle,
  onFileClick,
}: TeamWorkspaceProps): React.JSX.Element => {
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res: WorkspaceListResponse = await api.workspace.list(dirPath);
      if (res.error) {
        setError(res.error);
        setEntries([]);
      } else {
        setEntries(res.files);
        setCurrentDir(res.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load root when expanded
  useEffect(() => {
    if (isExpanded && projectPath && !currentDir) {
      setCurrentDir(projectPath);
      void loadDir(projectPath);
    }
  }, [isExpanded, projectPath, currentDir, loadDir]);

  useEffect(() => {
    setCurrentDir(null);
    setEntries([]);
    setError(null);
  }, [projectPath]);

  const handleEntryClick = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (entry.isDirectory && currentDir) {
        void loadDir(joinWorkspacePath(currentDir, entry.name));
      } else if (currentDir) {
        onFileClick(joinWorkspacePath(currentDir, entry.name));
      }
    },
    [currentDir, loadDir, onFileClick]
  );

  const handleGoUp = useCallback(() => {
    if (!currentDir || !projectPath) return;
    const parent = currentDir.split('/').slice(0, -1).join('/');
    if (parent.length >= projectPath.length) {
      void loadDir(parent || projectPath);
    }
  }, [currentDir, projectPath, loadDir]);

  const handleBreadcrumbClick = useCallback(
    (path: string) => {
      void loadDir(path);
    },
    [loadDir]
  );

  const breadcrumb = buildBreadcrumb(projectPath, currentDir || projectPath);
  const showGoUp = currentDir !== projectPath;

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      {/* Team header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
        onClick={onToggle}
      >
        <ChevronDown
          size={14}
          className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${isExpanded ? '' : '-rotate-90'}`}
        />
        <HardDrive size={14} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--color-text)]">
            {teamDisplayName}
          </span>
          <span
            className="block truncate font-mono text-[10px] text-[var(--color-text-muted)]"
            title={projectPath}
          >
            {projectPath}
          </span>
        </span>
        <span className="shrink-0 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">
          当前
        </span>
      </button>

      {/* File browser */}
      {isExpanded && (
        <div className="flex flex-col">
          {/* Breadcrumb */}
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3 py-1.5 text-xs">
            {showGoUp && (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                onClick={handleGoUp}
                title="返回上级"
              >
                <ArrowUp size={14} />
              </button>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
              {breadcrumb.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-0.5">
                  {i > 0 && (
                    <ChevronRight size={10} className="text-[var(--color-text-muted)] opacity-50" />
                  )}
                  <button
                    type="button"
                    className={`truncate text-[11px] transition-colors hover:text-[var(--color-text)] ${
                      i === breadcrumb.length - 1
                        ? 'font-medium text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)]'
                    }`}
                    onClick={() => handleBreadcrumbClick(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* File list */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="space-y-1 p-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="h-7 animate-pulse rounded bg-[var(--color-surface-raised)]"
                  />
                ))}
              </div>
            )}

            {error && !loading && (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-red-400">
                {error}
              </div>
            )}

            {!loading && !error && entries.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-6 text-[var(--color-text-muted)]">
                <Folder size={20} className="opacity-30" />
                <span className="text-xs">空目录</span>
              </div>
            )}

            {!loading &&
              entries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
                  onClick={() => handleEntryClick(entry)}
                >
                  {entry.isDirectory ? (
                    <FolderOpen size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                  ) : (
                    <FileIcon fileName={entry.name} className="size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {!entry.isDirectory && entry.size > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]">
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// WorkspaceBrowser — shows current team's workspace only
// ---------------------------------------------------------------------------

export const WorkspaceBrowser = (): React.JSX.Element => {
  const { selectedTeamName, teams, activeTabId, paneLayout } = useStore(
    useShallow((s) => ({
      selectedTeamName: s.selectedTeamName,
      teams: s.teams,
      activeTabId: s.activeTabId,
      paneLayout: s.paneLayout,
    }))
  );
  const revealFileInEditor = useStore((s) => s.revealFileInEditor);
  const [systemManagerProjectPath, setSystemManagerProjectPath] = useState<string | null>(null);

  const scopedTeamName = useMemo(() => {
    if (!activeTabId) {
      return selectedTeamName;
    }
    for (const pane of paneLayout.panes) {
      const tab = pane.tabs.find((item) => item.id === activeTabId);
      if (tab?.type === 'team' && tab.teamName) {
        return tab.teamName;
      }
    }
    return selectedTeamName;
  }, [activeTabId, paneLayout.panes, selectedTeamName]);

  useEffect(() => {
    if (scopedTeamName !== SYSTEM_MANAGER_TEAM_NAME) {
      setSystemManagerProjectPath(null);
      return;
    }

    let cancelled = false;
    void api.systemManager
      .getConfig()
      .then((config) => {
        if (!cancelled) setSystemManagerProjectPath(config.selectedWorkDir);
      })
      .catch(() => {
        if (!cancelled) setSystemManagerProjectPath(null);
      });

    return () => {
      cancelled = true;
    };
  }, [scopedTeamName]);

  const currentTeamWorkspace = useMemo(() => {
    if (!scopedTeamName) {
      return null;
    }
    if (scopedTeamName === SYSTEM_MANAGER_TEAM_NAME) {
      return {
        teamName: SYSTEM_MANAGER_TEAM_NAME,
        teamDisplayName: SYSTEM_MANAGER_DISPLAY_NAME,
        projectPath: systemManagerProjectPath,
      };
    }
    const team = teams.find((candidate) => candidate.teamName === scopedTeamName);
    if (!team) {
      return null;
    }
    const projectPath = (team.projectPath ?? team.workDir ?? '').trim();
    if (!projectPath) {
      return {
        teamName: team.teamName,
        teamDisplayName: team.displayName || team.teamName,
        projectPath: null,
      };
    }
    return {
      teamName: team.teamName,
      teamDisplayName: team.displayName || team.teamName,
      projectPath,
    };
  }, [scopedTeamName, systemManagerProjectPath, teams]);

  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setExpanded(true);
  }, [currentTeamWorkspace?.teamName, currentTeamWorkspace?.projectPath]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      // Reuse existing editable overlay chain:
      // revealFileInEditor -> TeamDetailView opens ProjectEditorOverlay -> revealAndOpenFile
      revealFileInEditor(filePath);
    },
    [revealFileInEditor]
  );

  if (!scopedTeamName) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FolderOpen size={32} className="opacity-30" />
        <p className="text-sm text-[var(--color-text-muted)]">暂无工作空间</p>
        <p className="text-xs text-[var(--color-text-muted)] opacity-60">
          请选择团队后查看当前团队目录
        </p>
      </div>
    );
  }

  if (!currentTeamWorkspace?.projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FolderOpen size={32} className="opacity-30" />
        <p className="text-sm text-[var(--color-text-muted)]">当前团队未配置工作目录</p>
        <p className="text-xs text-[var(--color-text-muted)] opacity-60">
          在团队编辑中设置项目路径后，这里会显示并可直接编辑文件
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <TeamWorkspace
          key={`${currentTeamWorkspace.teamName}:${currentTeamWorkspace.projectPath}`}
          teamDisplayName={currentTeamWorkspace.teamDisplayName}
          projectPath={currentTeamWorkspace.projectPath}
          isExpanded={expanded}
          onToggle={() => setExpanded((prev) => !prev)}
          onFileClick={handleFileClick}
        />
      </div>
    </div>
  );
};

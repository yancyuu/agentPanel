import React, { useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Combobox } from '@renderer/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';
import { Check, ChevronLeft, ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react';

import { buildProjectPathOptions } from './projectPathOptions';

import type { Project } from '@shared/types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string): React.JSX.Element {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const pattern = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const parts = text.split(pattern);

  return (
    <span>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === query.toLowerCase();
        if (!isMatch) {
          return <span key={`${part}-${index}`}>{part}</span>;
        }
        return (
          <mark
            key={`${part}-${index}`}
            // eslint-disable-next-line tailwindcss/no-custom-classname -- Tailwind arbitrary value with CSS variable
            className="bg-[var(--color-accent)]/25 rounded px-0.5 text-[var(--color-text)]"
          >
            {part}
          </mark>
        );
      })}
    </span>
  );
}

export type CwdMode = 'project' | 'custom';

interface ProjectPathSelectorProps {
  cwdMode: CwdMode;
  onCwdModeChange: (mode: CwdMode) => void;
  selectedProjectPath: string;
  onSelectedProjectPathChange: (path: string) => void;
  customCwd: string;
  onCustomCwdChange: (cwd: string) => void;
  projects: Project[];
  projectsLoading: boolean;
  projectsError: string | null;
  fieldError?: string | null;
}

export const ProjectPathSelector = ({
  cwdMode,
  onCwdModeChange,
  selectedProjectPath,
  onSelectedProjectPathChange,
  customCwd,
  onCustomCwdChange,
  projects,
  projectsLoading,
  projectsError,
  fieldError,
}: ProjectPathSelectorProps): React.JSX.Element => {
  const projectOptions = React.useMemo(
    () => buildProjectPathOptions(projects, selectedProjectPath),
    [projects, selectedProjectPath]
  );

  return (
    <div className="space-y-1.5">
      <Label>项目</Label>
      <div className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          <div className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            <button
              type="button"
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                cwdMode === 'project'
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onCwdModeChange('project')}
            >
              从项目列表选择
            </button>
            <button
              type="button"
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                cwdMode === 'custom'
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onCwdModeChange('custom')}
            >
              自定义路径
            </button>
          </div>

          <div className="min-w-0 flex-1">
            {cwdMode === 'project' ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <FolderOpen size={16} className="shrink-0 text-[var(--color-text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <Combobox
                      options={projectOptions}
                      value={selectedProjectPath}
                      onValueChange={onSelectedProjectPathChange}
                      placeholder={projectsLoading ? '正在加载项目...' : '选择项目...'}
                      searchPlaceholder="按名称或路径搜索项目"
                      emptyMessage="未找到匹配项"
                      disabled={projectsLoading || projectOptions.length === 0}
                      renderOption={(option, isSelected, query) => (
                        <>
                          <Check
                            className={cn(
                              'mr-2 size-3.5 shrink-0',
                              isSelected ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-[var(--color-text)]">
                              {renderHighlightedText(option.label, query)}
                            </p>
                            <p className="truncate text-[var(--color-text-muted)]">
                              {renderHighlightedText(option.description ?? '', query)}
                            </p>
                          </div>
                        </>
                      )}
                    />
                  </div>
                </div>
                {!selectedProjectPath ? (
                  <p className="text-[11px] text-[var(--color-text-muted)]">请从列表中选择项目</p>
                ) : null}
                {projectsError ? <p className="text-[11px] text-red-300">{projectsError}</p> : null}
                {!projectsLoading && projectOptions.length === 0 ? (
                  <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                    未找到项目，请切换到自定义路径。
                  </p>
                ) : null}
              </div>
            ) : (
              <FolderBrowser
                value={customCwd}
                onChange={onCustomCwdChange}
                fieldError={fieldError}
              />
            )}
          </div>
        </div>
      </div>
      {fieldError ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {fieldError}
        </p>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// FolderBrowser — inline directory browser using server browseFolders endpoint
// ---------------------------------------------------------------------------

interface FolderBrowserProps {
  value: string;
  onChange: (path: string) => void;
  fieldError?: string | null;
}

const FolderBrowser = ({ value, onChange, fieldError }: FolderBrowserProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState(value || '');
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.config.browseFolders(dirPath || undefined);
      setCurrentPath(result.path);
      setDirs(result.dirs);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法访问目录');
      setDirs([]);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    void browse(value || '');
  };

  const handleSelect = (dir: string) => {
    onChange(dir);
    setOpen(false);
  };

  const handleConfirm = () => {
    const trimmed = currentPath.trim();
    if (trimmed) {
      onChange(trimmed);
    }
    setOpen(false);
  };

  const handleNavigateUp = () => {
    if (currentPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
      void browse(parent);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <FolderOpen size={16} className="shrink-0 text-[var(--color-text-muted)]" />
        <Input
          className="h-8 flex-1 text-xs"
          value={value}
          aria-label="自定义工作目录"
          onChange={(event) => onChange(event.target.value)}
          placeholder="/absolute/path/to/project"
        />
        <Button variant="outline" size="sm" onClick={handleOpen}>
          浏览
        </Button>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">如果目录不存在，将自动创建。</p>
      {fieldError && (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {fieldError}
        </p>
      )}

      <Dialog
        open={open}
        onOpenChange={(o: boolean) => {
          if (!o) setOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>选择目录</DialogTitle>
          </DialogHeader>

          {/* Path breadcrumb + 手动输入（空目录时也能直接键入目标路径） */}
          <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            <button
              type="button"
              className="shrink-0 hover:text-[var(--color-text)]"
              onClick={handleNavigateUp}
              disabled={!currentPath || currentPath === '/'}
              aria-label="返回上一级"
            >
              <ChevronLeft size={14} />
            </button>
            <Input
              className="h-7 flex-1 font-mono text-xs"
              value={currentPath}
              aria-label="手动输入目录路径"
              placeholder="输入或修改目录路径"
              onChange={(event) => setCurrentPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleConfirm();
                }
              }}
            />
          </div>

          {/* Directory list */}
          <div className="max-h-64 overflow-auto rounded-md border border-[var(--color-border)]">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            )}
            {error && <div className="px-3 py-4 text-xs text-red-400">{error}</div>}
            {!loading && !error && dirs.length === 0 && (
              <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
                此目录下没有子目录，可直接在上方输入框修改路径后点「选择」。
              </div>
            )}
            {!loading && !error && dirs.length > 0 && (
              <ul className="divide-y divide-[var(--color-border)]">
                {dirs.map((dir) => (
                  <li key={dir}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-raised)]"
                      onClick={() => void browse(dir)}
                      onDoubleClick={() => handleSelect(dir)}
                    >
                      <Folder size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                      <span className="truncate">{dir}</span>
                      <ChevronRight
                        size={14}
                        className="ml-auto shrink-0 text-[var(--color-text-muted)]"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={handleConfirm} disabled={!currentPath.trim()}>
              选择
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

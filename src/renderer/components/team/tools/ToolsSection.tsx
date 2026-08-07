/*
 * ToolsSection — per-worker capabilities management.
 * MCP uses a cc-switch style model: global templates create project instances.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { McpLibraryEnableDialog } from '@renderer/components/extensions/mcp/McpLibraryEnableDialog';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { useStore } from '@renderer/store';
import { Plus, RefreshCw, Wrench } from 'lucide-react';

import { AddMcpInline } from './AddMcpInline';
import { AddSkillInline } from './AddSkillInline';
import { McpChip } from './McpChip';
import { SkillChip } from './SkillChip';

import type { McpLibraryEntry, SkillCatalogItem } from '@shared/types/extensions';

interface ToolsSectionProps {
  teamName: string;
  projectPath: string | null;
  harnessType?: string;
}

function summarizeMcp(entry: McpLibraryEntry): string {
  if (entry.installSpec.type === 'stdio') {
    return `stdio · ${entry.installSpec.npmPackage}${entry.installSpec.npmVersion ? `@${entry.installSpec.npmVersion}` : ''}`;
  }
  return `${entry.installSpec.transportType} · ${entry.installSpec.url}`;
}

export const ToolsSection = ({
  teamName,
  projectPath,
  harnessType,
}: ToolsSectionProps): React.JSX.Element => {
  // ── Store selectors ──
  const mcpByPath = useStore((s) => s.mcpInstalledServersByProjectPath);
  const diagnosticsByPath = useStore((s) => s.mcpDiagnosticsByProjectPath);
  const skillsByPath = useStore((s) => s.skillsProjectCatalogByProjectPath);
  const mcpFetchInstalled = useStore((s) => s.mcpFetchInstalled);
  const runMcpDiagnostics = useStore((s) => s.runMcpDiagnostics);
  const fetchSkillsCatalog = useStore((s) => s.fetchSkillsCatalog);
  const fetchSkillDetail = useStore((s) => s.fetchSkillDetail);
  const applySkillImport = useStore((s) => s.applySkillImport);
  const previewSkillImport = useStore((s) => s.previewSkillImport);
  const uninstallMcpServer = useStore((s) => s.uninstallMcpServer);
  const deleteSkill = useStore((s) => s.deleteSkill);
  const skillDetailsById = useStore((s) => s.skillsDetailsById);

  // ── Local state ──
  const [addingMcp, setAddingMcp] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const [mcpLibrary, setMcpLibrary] = useState<McpLibraryEntry[]>([]);
  const [userSkills, setUserSkills] = useState<SkillCatalogItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [selectedMcpTemplate, setSelectedMcpTemplate] = useState<McpLibraryEntry | null>(null);
  const [importingMcpTemplates, setImportingMcpTemplates] = useState(false);
  const [enablingSkillId, setEnablingSkillId] = useState<string | null>(null);
  const [mcpSearch, setMcpSearch] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [showAllMcp, setShowAllMcp] = useState(false);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);

  // ── Derived data ──
  const mcpServers = useMemo(
    () => (projectPath ? (mcpByPath[projectPath] ?? []) : []),
    [mcpByPath, projectPath]
  );
  // Diagnostics are stored keyed by `getMcpDiagnosticKey(name, scope)`, but the
  // scope is not always present (e.g. the text-mode CLI parser omits it), so the
  // scoped key can't be reconstructed reliably from an installed entry. Index by
  // server name instead — chip rows already assume names are unique per project.
  const diagnosticByName = useMemo(() => {
    const record = projectPath ? (diagnosticsByPath[projectPath] ?? {}) : {};
    return Object.fromEntries(Object.values(record).map((d) => [d.name, d] as const));
  }, [diagnosticsByPath, projectPath]);

  // Deduplicate skills by name (same skill may appear from multiple roots)
  const skills = useMemo(() => {
    const raw = projectPath ? (skillsByPath[projectPath] ?? []) : [];
    const seen = new Set<string>();
    return raw.filter((skill) => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [skillsByPath, projectPath]);

  const installedMcpNames = useMemo(
    () => new Set(mcpServers.map((entry) => entry.name.toLowerCase())),
    [mcpServers]
  );
  const installedSkillNames = useMemo(
    () => new Set(skills.map((skill) => skill.name.toLowerCase())),
    [skills]
  );
  const availableMcpLibrary = useMemo(() => {
    const query = mcpSearch.trim().toLowerCase();
    return mcpLibrary.filter((entry) => {
      if (!query) return true;
      return [entry.name, entry.description ?? '', summarizeMcp(entry)]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [mcpLibrary, mcpSearch]);
  const availableUserSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    return userSkills.filter((skill) => {
      if (installedSkillNames.has(skill.name.toLowerCase())) return false;
      if (!query) return true;
      return [skill.name, skill.description ?? '', skill.folderName]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [installedSkillNames, skillSearch, userSkills]);
  const visibleMcpLibrary = showAllMcp ? availableMcpLibrary : availableMcpLibrary.slice(0, 6);
  const visibleUserSkills = showAllSkills ? availableUserSkills : availableUserSkills.slice(0, 6);
  const refreshLibraries = useCallback(async (): Promise<void> => {
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const [libraryEntries, globalSkills] = await Promise.all([
        api.mcpRegistry?.libraryList?.() ?? Promise.resolve([]),
        api.skills?.list?.() ?? Promise.resolve([]),
      ]);
      setMcpLibrary(libraryEntries);
      setUserSkills(globalSkills);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : '加载全局能力库失败');
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  // ── Fetch data on mount ──
  useEffect(() => {
    if (projectPath) {
      mcpFetchInstalled(projectPath).catch(() => {});
      runMcpDiagnostics(projectPath).catch(() => {});
      fetchSkillsCatalog(projectPath).catch(() => {});
    }
    void refreshLibraries();
  }, [projectPath, mcpFetchInstalled, runMcpDiagnostics, fetchSkillsCatalog, refreshLibraries]);

  // ── Handlers ──
  const handleRemoveMcp = useCallback(
    (entry: { name: string; scope: string }) => {
      void (async () => {
        const confirmed = await confirm({
          title: '移除 MCP 项目实例',
          message: `确认从当前项目移除 MCP 实例「${entry.name}」？全局模板不会被删除。`,
          confirmLabel: '移除实例',
          cancelLabel: '取消',
          variant: 'danger',
        });
        if (!confirmed) return;
        uninstallMcpServer('', entry.name, entry.scope, projectPath ?? undefined)
          .then(() => {
            setApplyNotice('MCP 实例已移除；正在运行的数字员工需要重启后才会卸载该能力。');
          })
          .catch(() => {});
      })();
    },
    [uninstallMcpServer, projectPath]
  );

  const handleRemoveSkill = useCallback(
    (skill: { id: string; name: string }) => {
      void (async () => {
        const confirmed = await confirm({
          title: '禁用 Skill',
          message: `确认从当前团队禁用 Skill「${skill.name}」？全局 Skill 仍会保留。`,
          confirmLabel: '禁用',
          cancelLabel: '取消',
          variant: 'danger',
        });
        if (!confirmed) return;
        deleteSkill({ skillId: skill.id, projectPath: projectPath ?? undefined })
          .then(() => {
            setApplyNotice('Skill 已禁用；正在运行的数字员工需要重启后才会卸载该能力。');
          })
          .catch(() => {});
      })();
    },
    [deleteSkill, projectPath]
  );

  const handleMcpTemplateAdded = useCallback(
    (entry: McpLibraryEntry) => {
      setAddingMcp(false);
      setMcpLibrary((prev) => {
        const next = prev.filter((item) => item.id !== entry.id);
        return [entry, ...next];
      });
      setSelectedMcpTemplate(entry);
      void refreshLibraries();
    },
    [refreshLibraries]
  );

  const handleMcpInstanceAdded = useCallback(() => {
    setSelectedMcpTemplate(null);
    if (projectPath) {
      mcpFetchInstalled(projectPath).catch(() => {});
      runMcpDiagnostics(projectPath).catch(() => {});
    }
    void refreshLibraries();
  }, [projectPath, mcpFetchInstalled, runMcpDiagnostics, refreshLibraries]);

  const handleImportMcpTemplates = useCallback(() => {
    void (async () => {
      if (!api.mcpRegistry?.libraryImport) {
        setLibraryError('MCP 模板导入 API 不可用');
        return;
      }
      setImportingMcpTemplates(true);
      setLibraryError(null);
      try {
        const result = await api.mcpRegistry.libraryImport({
          projectPath: projectPath ?? undefined,
        });
        await refreshLibraries();
        setApplyNotice(
          `已从现有 MCP 配置导入模板：新增 ${result.imported.length} 个，跳过 ${result.skipped.length} 个。`
        );
      } catch (err) {
        setLibraryError(err instanceof Error ? err.message : '导入现有 MCP 配置失败');
      } finally {
        setImportingMcpTemplates(false);
      }
    })();
  }, [projectPath, refreshLibraries]);

  const handleSkillAdded = useCallback(() => {
    setAddingSkill(false);
    if (projectPath) {
      fetchSkillsCatalog(projectPath).catch(() => {});
    }
    void refreshLibraries();
  }, [projectPath, fetchSkillsCatalog, refreshLibraries]);

  const enableSkillFromLibrary = useCallback(
    async (skill: SkillCatalogItem): Promise<void> => {
      if (!projectPath) return;
      setEnablingSkillId(skill.id);
      try {
        await fetchSkillDetail(skill.id);
        const detail =
          useStore.getState().skillsDetailsById[skill.id] ?? skillDetailsById[skill.id];
        const sourceDir = detail?.item.skillDir ?? skill.skillDir;
        const preview = await previewSkillImport({
          sourceDir,
          scope: 'project',
          rootKind: skill.rootKind,
          projectPath,
          folderName: skill.folderName,
        });
        await applySkillImport({
          sourceDir,
          scope: 'project',
          rootKind: skill.rootKind,
          projectPath,
          folderName: skill.folderName,
          reviewPlanId: preview.planId,
        });
        await fetchSkillsCatalog(projectPath);
        setApplyNotice('Skill 已启用；正在运行的数字员工需要重启后才会加载新能力。');
      } finally {
        setEnablingSkillId(null);
      }
    },
    [
      applySkillImport,
      fetchSkillDetail,
      fetchSkillsCatalog,
      previewSkillImport,
      projectPath,
      skillDetailsById,
    ]
  );

  if (!projectPath) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-[var(--color-text-muted)]">
        <Wrench size={12} />
        <span>需要关联项目目录才能管理能力</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-1 py-2">
      {libraryError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
          {libraryError}
        </div>
      ) : null}

      {applyNotice ? (
        <div className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1.5 text-xs text-indigo-300">
          {applyNotice}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-[var(--color-text-muted)]">
          当前项目管理 MCP 实例；全局库只提供可复用模板。先导入/新建模板，再添加为项目实例。
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={importingMcpTemplates}
            onClick={handleImportMcpTemplates}
          >
            {importingMcpTemplates ? '导入中...' : '导入现有 MCP'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => void refreshLibraries()}
          >
            <RefreshCw className={libraryLoading ? 'mr-1 size-3 animate-spin' : 'mr-1 size-3'} />
            刷新
          </Button>
        </div>
      </div>

      {/* MCP capabilities */}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.015] p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
            <span>MCP 实例</span>
            <span className="text-[10px]">
              已配置实例 {mcpServers.length} · 模板 {mcpLibrary.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setAddingMcp(true)}
          >
            <Plus size={10} className="mr-1" />
            新建模板
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {mcpServers.map((entry) => (
            <McpChip
              key={entry.name}
              entry={entry}
              diagnostic={diagnosticByName[entry.name]}
              onRemove={handleRemoveMcp}
            />
          ))}
          {mcpServers.length === 0 ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              当前项目还没有配置 MCP 实例。
            </span>
          ) : null}
        </div>

        {addingMcp ? (
          <AddMcpInline onAdded={handleMcpTemplateAdded} onCancel={() => setAddingMcp(false)} />
        ) : null}

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            从模板添加
          </div>
          <Input
            value={mcpSearch}
            onChange={(event) => setMcpSearch(event.target.value)}
            placeholder="搜索 MCP 模板..."
            className="h-7 text-xs"
          />
          {availableMcpLibrary.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {visibleMcpLibrary.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs text-[var(--color-text)]">{entry.name}</div>
                    <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                      {summarizeMcp(entry)}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setSelectedMcpTemplate(entry)}
                  >
                    从模板添加
                  </Button>
                </div>
              ))}
              {availableMcpLibrary.length > 6 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 justify-start px-2 text-[11px]"
                  onClick={() => setShowAllMcp((value) => !value)}
                >
                  {showAllMcp ? '收起' : `显示全部 ${availableMcpLibrary.length} 个模板`}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-[var(--color-border)] p-2 text-xs text-[var(--color-text-muted)]">
              <span>全局 MCP 模板库暂无可添加项。可以从现有 MCP 配置导入，或新建模板。</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={importingMcpTemplates}
                  onClick={handleImportMcpTemplates}
                >
                  {importingMcpTemplates ? '导入中...' : '导入现有 MCP'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setAddingMcp(true)}
                >
                  新建模板
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <McpLibraryEnableDialog
        open={Boolean(selectedMcpTemplate)}
        entry={selectedMcpTemplate}
        projectPath={projectPath}
        installedServers={mcpServers}
        harnessType={harnessType}
        onClose={() => setSelectedMcpTemplate(null)}
        onEnabled={handleMcpInstanceAdded}
      />

      {/* Skill capabilities */}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.015] p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-muted)]">
            <span>Skill 能力</span>
            <span className="text-[10px]">
              已启用 {skills.length} · 全局 {userSkills.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setAddingSkill(true)}
          >
            <Plus size={10} className="mr-1" />
            新建 Skill
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {skills.map((skill) => (
            <SkillChip key={skill.id} skill={skill} onRemove={handleRemoveSkill} />
          ))}
          {skills.length === 0 ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              当前团队还没有启用 Skill。
            </span>
          ) : null}
        </div>

        {addingSkill ? (
          <AddSkillInline
            projectPath={projectPath}
            projectLabel={teamName}
            onAdded={handleSkillAdded}
            onCancel={() => setAddingSkill(false)}
          />
        ) : null}

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            从全局 Skill 启用
          </div>
          <Input
            value={skillSearch}
            onChange={(event) => setSkillSearch(event.target.value)}
            placeholder="搜索 Skill..."
            className="h-7 text-xs"
          />
          {availableUserSkills.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {visibleUserSkills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs text-[var(--color-text)]">{skill.name}</div>
                    <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                      {skill.description || skill.folderName}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={enablingSkillId === skill.id}
                    onClick={() => void enableSkillFromLibrary(skill)}
                  >
                    {enablingSkillId === skill.id ? '启用中...' : '启用'}
                  </Button>
                </div>
              ))}
              {availableUserSkills.length > 6 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 justify-start px-2 text-[11px]"
                  onClick={() => setShowAllSkills((value) => !value)}
                >
                  {showAllSkills ? '收起' : `显示全部 ${availableUserSkills.length} 个 Skill`}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-2 text-xs text-[var(--color-text-muted)]">
              全局 Skill 暂无可启用项。可以先创建用户级 Skill，再在团队中启用。
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

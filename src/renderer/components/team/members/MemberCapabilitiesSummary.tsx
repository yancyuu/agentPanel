import { useEffect, useId, useMemo, useState } from 'react';

import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { PlugZap, Sparkles } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { ResolvedTeamMember } from '@shared/types';
import type { InstalledMcpEntry, SkillCatalogItem } from '@shared/types/extensions';

interface MemberCapabilitiesSummaryProps {
  open: boolean;
  member: ResolvedTeamMember;
  teamName: string;
}

const BUILTIN_HERMIT_MCP_NAMES = new Set(['hermit-tasks', 'hermit-workbench']);

function normalizeCapabilityName(name: string): string {
  return name.trim().toLowerCase();
}

function dedupeSkills(skills: readonly SkillCatalogItem[]): SkillCatalogItem[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = normalizeCapabilityName(skill.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatSkillSource(skill: SkillCatalogItem): string {
  const scope = skill.scope === 'project' ? '项目' : '用户';
  return `${scope} · ${skill.rootKind}`;
}

function formatMcpMetadata(entry: InstalledMcpEntry): string {
  const scopeLabels: Record<InstalledMcpEntry['scope'], string> = {
    local: '本地',
    user: '用户',
    project: '项目',
    global: '全局',
  };
  return [scopeLabels[entry.scope], entry.transport].filter(Boolean).join(' · ');
}

export const MemberCapabilitiesSummary = ({
  open,
  member,
  teamName,
}: Readonly<MemberCapabilitiesSummaryProps>): React.JSX.Element => {
  const {
    teamProjectPath,
    skillsByPath,
    skillsLoadingByPath,
    skillsErrorByPath,
    mcpByPath,
    fetchSkillsCatalog,
    mcpFetchInstalled,
  } = useStore(
    useShallow((state) => ({
      teamProjectPath: selectTeamDataForName(state, teamName)?.config.projectPath ?? null,
      skillsByPath: state.skillsProjectCatalogByProjectPath,
      skillsLoadingByPath: state.skillsCatalogLoadingByProjectPath,
      skillsErrorByPath: state.skillsCatalogErrorByProjectPath,
      mcpByPath: state.mcpInstalledServersByProjectPath,
      fetchSkillsCatalog: state.fetchSkillsCatalog,
      mcpFetchInstalled: state.mcpFetchInstalled,
    }))
  );
  const capabilityPath = member.cwd?.trim() || teamProjectPath?.trim() || null;
  const skillsHeadingId = useId();
  const mcpHeadingId = useId();
  const [mcpErrorByPath, setMcpErrorByPath] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!open || !capabilityPath) return;

    let cancelled = false;
    void fetchSkillsCatalog(capabilityPath);
    void mcpFetchInstalled(capabilityPath)
      .then(() => {
        if (cancelled) return;
        setMcpErrorByPath((current) => ({ ...current, [capabilityPath]: null }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMcpErrorByPath((current) => ({
          ...current,
          [capabilityPath]: error instanceof Error ? error.message : '读取 MCP 配置失败',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [capabilityPath, fetchSkillsCatalog, mcpFetchInstalled, open]);

  const skills = useMemo(
    () => dedupeSkills(capabilityPath ? (skillsByPath[capabilityPath] ?? []) : []),
    [capabilityPath, skillsByPath]
  );
  const mcpServers = capabilityPath ? (mcpByPath[capabilityPath] ?? []) : [];
  const hasSkillsSnapshot = capabilityPath
    ? Object.prototype.hasOwnProperty.call(skillsByPath, capabilityPath)
    : false;
  const skillsLoading = capabilityPath
    ? (skillsLoadingByPath[capabilityPath] ?? (!hasSkillsSnapshot && open))
    : false;
  const skillsError = capabilityPath ? (skillsErrorByPath[capabilityPath] ?? null) : null;
  const hasMcpSnapshot = capabilityPath
    ? Object.prototype.hasOwnProperty.call(mcpByPath, capabilityPath)
    : false;
  const mcpError = capabilityPath ? (mcpErrorByPath[capabilityPath] ?? null) : null;
  const mcpLoading = capabilityPath !== null && !hasMcpSnapshot && !mcpError && open;
  return (
    <div className="space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
      <div className="min-w-0 text-[11px] text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text-secondary)]">生效项目：</span>{' '}
        <span className="font-mono" title={capabilityPath ?? undefined}>
          {capabilityPath ?? '尚未绑定项目目录'}
        </span>
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <section
          aria-labelledby={skillsHeadingId}
          className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <h3
              id={skillsHeadingId}
              className="flex items-center gap-2 text-xs font-medium text-[var(--color-text)]"
            >
              <Sparkles className="size-3.5 text-[var(--color-text-muted)]" />
              Skills
            </h3>
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {skills.length}
            </span>
          </div>
          <div className="max-h-48 overflow-y-auto p-2">
            {!capabilityPath ? (
              <p className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]">
                绑定项目目录后可发现 Skills。
              </p>
            ) : skillsLoading && skills.length === 0 ? (
              <p
                role="status"
                className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]"
              >
                正在发现 Skills…
              </p>
            ) : skillsError ? (
              <p role="alert" className="px-1 py-3 text-xs text-red-400">
                Skills 加载失败：{skillsError}
              </p>
            ) : skills.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]">
                当前项目尚未发现 Skill。
              </p>
            ) : (
              <ul className="space-y-1" aria-label="生效 Skills">
                {skills.map((skill) => (
                  <li
                    key={skill.id}
                    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-2"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-medium text-[var(--color-text)]">
                        {skill.name}
                      </span>
                      <span className="shrink-0 text-[9px] text-[var(--color-text-muted)]">
                        {formatSkillSource(skill)}
                      </span>
                    </div>
                    {skill.description ? (
                      <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
                        {skill.description}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section
          aria-labelledby={mcpHeadingId}
          className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
            <h3
              id={mcpHeadingId}
              className="flex items-center gap-2 text-xs font-medium text-[var(--color-text)]"
            >
              <PlugZap className="size-3.5 text-[var(--color-text-muted)]" />
              MCP
            </h3>
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {mcpServers.length}
            </span>
          </div>
          <div className="max-h-48 space-y-2 overflow-y-auto p-2">
            {!capabilityPath ? (
              <p className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]">
                绑定项目目录后可发现 MCP。
              </p>
            ) : mcpLoading && mcpServers.length === 0 ? (
              <p
                role="status"
                className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]"
              >
                正在发现 MCP…
              </p>
            ) : mcpError ? (
              <p role="alert" className="px-1 py-3 text-xs text-red-400">
                MCP 加载失败：{mcpError}
              </p>
            ) : mcpServers.length === 0 ? (
              <p className="px-1 py-3 text-center text-xs text-[var(--color-text-muted)]">
                当前项目尚未配置其他 MCP。
              </p>
            ) : (
              <ul className="space-y-1" aria-label="生效 MCP">
                {mcpServers.map((entry) => {
                  const isBuiltin = BUILTIN_HERMIT_MCP_NAMES.has(
                    normalizeCapabilityName(entry.name)
                  );
                  return (
                    <li
                      key={`${entry.scope}:${entry.name}`}
                      className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">
                          {entry.name}
                        </span>
                        {isBuiltin ? (
                          <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-accent)]">
                            Hermit 内置
                          </span>
                        ) : null}
                        <span className="shrink-0 text-[9px] text-emerald-500">已配置</span>
                      </div>
                      <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                        {formatMcpMetadata(entry)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

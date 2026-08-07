import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { AlertTriangle, Download, Filter, Loader2, Package, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CapabilityPackDetailDialog } from './CapabilityPackDetailDialog';

import type { CapabilityPackExportRuntime, LoadedCapabilityPack } from '@shared/types/extensions';

const EXPORT_RUNTIMES: { value: CapabilityPackExportRuntime; label: string }[] = [
  { value: 'claudecode', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
];

function getPackCounts(pack: LoadedCapabilityPack): string {
  const commands = pack.manifest.capabilities.commands?.length ?? 0;
  const skills = pack.manifest.capabilities.skills?.length ?? 0;
  const workflows = pack.manifest.capabilities.workflows?.length ?? 0;
  const cron = pack.manifest.capabilities.cron?.length ?? 0;
  const mcpServers = pack.manifest.capabilities.mcpServers?.length ?? 0;
  return `${commands} commands · ${skills} skills · ${workflows} workflows · ${cron} cron · ${mcpServers} MCP`;
}

function isGlobalCapabilityPack(pack: LoadedCapabilityPack): boolean {
  return (
    pack.manifest.id === 'local-capabilities-global' ||
    pack.manifest.tags?.includes('global') === true
  );
}

function getPackSourceLabel(pack: LoadedCapabilityPack): string {
  if (pack.source === 'builtin') return 'Official';
  if (isGlobalCapabilityPack(pack)) return 'Global';
  if (pack.source === 'local') return 'Project';
  return 'Imported';
}

function getPackCategories(pack: LoadedCapabilityPack): string[] {
  if (pack.source === 'builtin') return ['official'];
  if (isGlobalCapabilityPack(pack)) return ['global'];
  if (pack.source === 'local') return ['local'];
  const tags = pack.manifest.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  return tags.length > 0 ? tags : [pack.manifest.namespace];
}

function getPackCapabilityKinds(pack: LoadedCapabilityPack): string[] {
  const kinds: string[] = [];
  if (pack.manifest.capabilities.commands?.length) kinds.push('commands');
  if (pack.manifest.capabilities.skills?.length) kinds.push('skills');
  if (pack.manifest.capabilities.workflows?.length) kinds.push('workflows');
  if (pack.manifest.capabilities.cron?.length) kinds.push('cron');
  if (pack.manifest.capabilities.mcpServers?.length) kinds.push('MCP');
  return kinds;
}

function countFilterValues(
  packs: LoadedCapabilityPack[],
  getValues: (pack: LoadedCapabilityPack) => string[]
): [string, number][] {
  const counts = new Map<string, number>();
  for (const pack of packs) {
    for (const value of getValues(pack)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const CapabilityPackFilterChips = ({
  counts,
  selected,
  onToggle,
  getLabel = (value) => value,
  activeClassName = 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300 shadow-sm',
}: {
  counts: [string, number][];
  selected: string[];
  onToggle: (value: string) => void;
  getLabel?: (value: string) => string;
  activeClassName?: string;
}): React.JSX.Element => {
  if (counts.length === 0) return <></>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {counts.map(([value, count]) => {
        const isActive = selected.includes(value);
        return (
          <Button
            key={value}
            variant="ghost"
            size="sm"
            onClick={() => onToggle(value)}
            aria-pressed={isActive}
            className={`h-7 rounded-full border px-2.5 text-[11px] font-medium transition-all ${
              isActive
                ? activeClassName
                : 'hover:bg-surface-raised/60 border-border bg-transparent text-text-secondary hover:border-border-emphasis hover:text-text'
            }`}
          >
            <span>{getLabel(value)}</span>
            <span
              className={`ml-1.5 rounded-full px-1 py-0.5 text-[9px] leading-none ${
                isActive
                  ? 'bg-surface-raised text-text-secondary'
                  : 'bg-surface-raised/70 text-text-muted'
              }`}
            >
              {count}
            </span>
          </Button>
        );
      })}
    </div>
  );
};

const CapabilityPackCard = ({
  pack,
  index,
  exporting,
  onExport,
  onOpen,
}: {
  pack: LoadedCapabilityPack;
  index: number;
  exporting: boolean;
  onExport: (packId: string, runtime: CapabilityPackExportRuntime) => void;
  onOpen: () => void;
}) => {
  const baseStriped = index % 2 === 0;
  const [runtime, setRuntime] = useState<CapabilityPackExportRuntime>('claudecode');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex w-full cursor-pointer flex-col gap-3 rounded-xl border p-4 text-left transition-all duration-200 hover:border-border-emphasis ${
        baseStriped ? 'bg-white/[0.045]' : 'bg-white/[0.015]'
      } ${pack.enabled ? 'border-l-2 border-border border-l-emerald-500/35' : 'border-border'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate text-sm font-semibold text-text">{pack.manifest.name}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[11px]">
              namespace: {pack.manifest.namespace}
            </Badge>
            <Badge
              variant="outline"
              className={
                pack.source === 'local'
                  ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                  : 'border-border text-text-secondary'
              }
            >
              {getPackSourceLabel(pack)}
            </Badge>
            <Badge
              variant="outline"
              className={
                pack.enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-border text-text-muted'
              }
            >
              {pack.enabled ? 'enabled' : 'disabled'}
            </Badge>
            <Badge variant="outline" className="border-border text-text-secondary">
              v{pack.manifest.version}
            </Badge>
          </div>
        </div>
        <Package className="size-4 shrink-0 text-text-muted" />
      </div>

      <p className="line-clamp-2 min-h-10 text-xs leading-5 text-text-secondary">
        {pack.manifest.description ||
          '项目能力包：commands、skills、workflows、cron 与 MCP 配置集合。'}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>{getPackCounts(pack)}</span>
        <span className="max-w-[50%] truncate font-mono text-[11px]" title={pack.packDir}>
          {pack.packDir}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <div onClick={(event) => event.stopPropagation()}>
          <Select
            value={runtime}
            onValueChange={(value) => setRuntime(value as CapabilityPackExportRuntime)}
          >
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder="选择 Harness" />
            </SelectTrigger>
            <SelectContent>
              {EXPORT_RUNTIMES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onExport(pack.manifest.id, runtime);
          }}
          disabled={exporting}
          className="rounded-lg px-3 text-xs"
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          导出
        </Button>
      </div>

      {pack.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-300">
          {pack.warnings.join('；')}
        </div>
      ) : null}
    </div>
  );
};

interface CapabilityPacksPanelProps {
  readonly teamName?: string;
  readonly teamDisplayName?: string;
}

export const CapabilityPacksPanel = ({
  teamName,
  teamDisplayName,
}: CapabilityPacksPanelProps = {}): React.JSX.Element => {
  const {
    capabilityPacks,
    capabilityPackList,
    capabilityPacksLoading,
    capabilityPacksError,
    capabilityPacksMutationLoading,
    capabilityPacksMutationError,
    fetchCapabilityPacks,
    importCapabilityPack,
    addExtensionToast,
  } = useStore(
    useShallow((state) => ({
      capabilityPacks: state.capabilityPacks,
      capabilityPackList: state.capabilityPackList,
      capabilityPacksLoading: state.capabilityPacksLoading,
      capabilityPacksError: state.capabilityPacksError,
      capabilityPacksMutationLoading: state.capabilityPacksMutationLoading,
      capabilityPacksMutationError: state.capabilityPacksMutationError,
      fetchCapabilityPacks: state.fetchCapabilityPacks,
      importCapabilityPack: state.importCapabilityPack,
      addExtensionToast: state.addExtensionToast,
    }))
  );
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);

  useEffect(() => {
    void fetchCapabilityPacks();
  }, [fetchCapabilityPacks]);

  const toggleCategory = useCallback((category: string) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category]
    );
  }, []);

  const toggleCapability = useCallback((capability: string) => {
    setSelectedCapabilities((prev) =>
      prev.includes(capability) ? prev.filter((item) => item !== capability) : [...prev, capability]
    );
  }, []);

  const scopedCapabilityPacks = useMemo(() => {
    if (!teamName) return capabilityPacks;

    const scopedTeamNames = new Set(
      [teamName, teamDisplayName].map((name) => name?.trim()).filter(Boolean)
    );
    return capabilityPacks.filter((pack) => {
      if (pack.source === 'builtin' || isGlobalCapabilityPack(pack)) return true;

      const packTeamName = pack.manifest.teamName?.trim();
      if (packTeamName) return scopedTeamNames.has(packTeamName);

      return pack.source !== 'local';
    });
  }, [capabilityPacks, teamDisplayName, teamName]);

  const categoryCounts = useMemo(
    () => countFilterValues(scopedCapabilityPacks, getPackCategories),
    [scopedCapabilityPacks]
  );

  const capabilityCounts = useMemo(
    () => countFilterValues(scopedCapabilityPacks, getPackCapabilityKinds),
    [scopedCapabilityPacks]
  );

  const filteredPacks = useMemo(
    () =>
      scopedCapabilityPacks.filter((pack) => {
        const matchesCategory =
          selectedCategories.length === 0 ||
          getPackCategories(pack).some((category) => selectedCategories.includes(category));
        const matchesCapability =
          selectedCapabilities.length === 0 ||
          getPackCapabilityKinds(pack).some((capability) =>
            selectedCapabilities.includes(capability)
          );
        return matchesCategory && matchesCapability;
      }),
    [scopedCapabilityPacks, selectedCapabilities, selectedCategories]
  );

  const groupedPacks = useMemo(() => {
    const groups = new Map<string, LoadedCapabilityPack[]>();
    for (const pack of filteredPacks) {
      // Exactly two groups: all local teams merged together, everything else
      // (official / global / imported) in the other. No per-team splitting.
      const isLocalTeam = pack.source === 'local' && !isGlobalCapabilityPack(pack);
      const groupName = isLocalTeam ? '项目资产' : '运行时 / 全局';
      groups.set(groupName, [...(groups.get(groupName) ?? []), pack]);
    }
    const order = ['运行时 / 全局', '项目资产'];
    return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [filteredPacks]);

  const totalCategoryCount = useMemo(() => {
    const categories = new Set<string>();
    for (const pack of scopedCapabilityPacks) {
      for (const category of getPackCategories(pack)) {
        categories.add(category);
      }
    }
    return categories.size;
  }, [scopedCapabilityPacks]);

  const totalCapabilityCount = useMemo(
    () =>
      scopedCapabilityPacks.reduce(
        (total, pack) =>
          total +
          (pack.manifest.capabilities.commands?.length ?? 0) +
          (pack.manifest.capabilities.skills?.length ?? 0) +
          (pack.manifest.capabilities.workflows?.length ?? 0) +
          (pack.manifest.capabilities.cron?.length ?? 0) +
          (pack.manifest.capabilities.mcpServers?.length ?? 0),
        0
      ),
    [scopedCapabilityPacks]
  );

  const warnings = useMemo(
    () => [
      ...(capabilityPackList?.warnings ?? []),
      ...(capabilityPacksError ? [capabilityPacksError] : []),
      ...(capabilityPacksMutationError ? [capabilityPacksMutationError] : []),
    ],
    [capabilityPackList?.warnings, capabilityPacksError, capabilityPacksMutationError]
  );

  const selectedPack = useMemo(
    () =>
      selectedPackId
        ? (scopedCapabilityPacks.find((pack) => pack.manifest.id === selectedPackId) ?? null)
        : null,
    [scopedCapabilityPacks, selectedPackId]
  );

  const activeFilterCount = selectedCategories.length + selectedCapabilities.length;
  const hasActiveFilters = activeFilterCount > 0;

  const clearFilters = useCallback(() => {
    setSelectedCategories([]);
    setSelectedCapabilities([]);
  }, []);

  const handleExport = (packId: string, runtime: CapabilityPackExportRuntime) => {
    void (async () => {
      const response = await fetch('/api/extensions/capability-packs/export/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId, runtime, overwrite: true }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Download capability pack failed');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `${packId}.zip`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      const warnings = response.headers.get('x-capability-pack-warnings');
      const decodedWarnings = warnings
        ? (JSON.parse(decodeURIComponent(warnings)) as string[]).filter(Boolean)
        : [];
      addExtensionToast('success', '能力包已下载', decodedWarnings.join('；'));
    })().catch((error) => {
      addExtensionToast(
        'error',
        '能力包下载失败',
        error instanceof Error ? error.message : String(error)
      );
    });
  };

  const handleImport = () => {
    const sourceDir = window.prompt('请输入能力包目录（包含 pack.json 的文件夹）');
    if (!sourceDir?.trim()) return;
    void importCapabilityPack({ sourceDir: sourceDir.trim(), overwrite: true })
      .then((result) => {
        addExtensionToast('success', '能力包已导入', result.warnings.join('；'));
      })
      .catch((error) => {
        addExtensionToast(
          'error',
          '能力包导入失败',
          error instanceof Error ? error.message : String(error)
        );
      });
  };

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised/50 rounded-xl border border-indigo-500/20 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Package className="mt-0.5 size-5 text-indigo-300" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text">项目能力包</h2>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                能力包就是一组可复用的本地智能体资产：commands、skills、workflows、cron 与 MCP
                配置。 你可以把当前项目里的能力打包后开放给外部用户，通过飞书、微信等 IM
                入口调用，而不是把能力散落在插件管理里。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleImport}
              disabled={capabilityPacksMutationLoading}
            >
              导入
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void fetchCapabilityPacks()}
              disabled={capabilityPacksLoading}
            >
              {capabilityPacksLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              刷新
            </Button>
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </div>
      )}

      {scopedCapabilityPacks.length > 0 ? (
        <div className="bg-surface-raised/20 rounded-xl p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="bg-surface-raised/60 flex size-8 items-center justify-center rounded-lg border border-border">
                    <Filter className="size-4 text-text-muted" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold text-text">按适用场景浏览</h2>
                      <Badge variant="outline" className="text-[11px] text-text-muted">
                        {activeFilterCount} 个筛选条件已启用
                      </Badge>
                    </div>
                    <p className="text-xs text-text-muted">按分类或能力缩小目录范围。</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
                  <Badge variant="secondary" className="font-normal">
                    {scopedCapabilityPacks.length} 个能力包
                  </Badge>
                  <Badge variant="secondary" className="font-normal">
                    {totalCategoryCount} 个分类
                  </Badge>
                  <Badge variant="secondary" className="font-normal">
                    {totalCapabilityCount} 项能力
                  </Badge>
                </div>
              </div>
              {hasActiveFilters ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="justify-start rounded-lg border border-border px-3 text-xs text-text-secondary hover:text-text lg:justify-center"
                >
                  清除所有筛选
                </Button>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-transparent">
              <div className="grid gap-0 xl:grid-cols-2">
                <section className="space-y-3 border-b border-border p-3 xl:border-b-0 xl:border-r">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                      分类
                    </span>
                    <span className="text-[11px] text-text-muted">
                      已选 {selectedCategories.length} 个
                    </span>
                  </div>
                  <CapabilityPackFilterChips
                    counts={categoryCounts}
                    selected={selectedCategories}
                    onToggle={toggleCategory}
                  />
                </section>

                <section className="space-y-3 border-b border-border p-3 xl:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                      能力
                    </span>
                    <span className="text-[11px] text-text-muted">
                      已选 {selectedCapabilities.length} 个
                    </span>
                  </div>
                  <CapabilityPackFilterChips
                    counts={capabilityCounts}
                    selected={selectedCapabilities}
                    onToggle={toggleCapability}
                    activeClassName="border-purple-500/40 bg-purple-500/15 text-purple-300 shadow-sm"
                  />
                </section>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {capabilityPacksLoading && scopedCapabilityPacks.length === 0 ? (
        <div className="bg-surface-raised/50 rounded-xl border border-border px-4 py-8 text-center text-sm text-text-muted">
          正在加载能力包...
        </div>
      ) : scopedCapabilityPacks.length === 0 ? (
        <div className="bg-surface/60 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
          还没有可用能力包。官方 AgentPanel 运维包会自动预装。
        </div>
      ) : filteredPacks.length === 0 ? (
        <div className="bg-surface/60 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
          当前筛选条件下没有能力包。
        </div>
      ) : (
        <div className="space-y-5">
          {groupedPacks.map(([category, packs]) => (
            <section key={category} className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
                  {category}
                </h3>
                <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[9px] text-text-muted">
                  {packs.length}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {packs.map((pack, index) => (
                  <CapabilityPackCard
                    key={pack.manifest.id}
                    pack={pack}
                    index={index}
                    exporting={capabilityPacksMutationLoading}
                    onExport={handleExport}
                    onOpen={() => setSelectedPackId(pack.manifest.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <CapabilityPackDetailDialog
        pack={selectedPack}
        open={selectedPackId !== null}
        onClose={() => setSelectedPackId(null)}
      />
    </div>
  );
};

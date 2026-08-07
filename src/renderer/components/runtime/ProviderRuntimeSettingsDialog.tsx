import { useCallback, useEffect, useMemo, useState } from 'react';

import { providersApi } from '@renderer/api/providers';
import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES } from '@renderer/components/team/HarnessCards';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { emitOpenHermitEvent, OPEN_HERMIT_EVENTS } from '@renderer/utils/openHermitEvents';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import type { CliProviderId, CliProviderStatus } from '@shared/types';
import type {
  AgentType,
  GlobalProvider,
  ProviderModelEntry,
  ProviderPreset,
} from '@shared/types/providers';

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: CliProviderStatus[];
  readonly initialProviderId: CliProviderId;
  readonly projectPath?: string | null;
  readonly providerStatusLoading?: Partial<Record<CliProviderId, boolean>>;
  readonly disabled?: boolean;
  readonly onSelectBackend: (providerId: CliProviderId, backendId: string) => Promise<void> | void;
  readonly onRefreshProvider?: (providerId: CliProviderId) => Promise<void> | void;
  readonly onRequestLogin?: (providerId: CliProviderId) => void;
}

interface ProviderFormState {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  modelsText: string;
  thinking: string;
  agentTypes: AgentType[];
  endpoints: Partial<Record<AgentType, string>>;
  agentModels: Partial<Record<AgentType, string>>;
  codexWireApi: string;
  codexHeadersText: string;
}

const AGENT_TYPE_BY_CLI_PROVIDER: Record<CliProviderId, AgentType> = {
  anthropic: 'claudecode',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

const CLI_PROVIDER_LABELS: Record<CliProviderId, string> = {
  anthropic: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

const CORE_AGENT_TYPES: AgentType[] = ['claudecode', 'codex', 'gemini', 'opencode'];

const PRESET_AGENT_KEY_MAP: Record<string, AgentType> = {
  claude: 'claudecode',
  anthropic: 'claudecode',
  claudecode: 'claudecode',
  codex: 'codex',
  openai: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

function normalizeAgentType(value: string): AgentType | null {
  const mapped = PRESET_AGENT_KEY_MAP[value.toLowerCase()];
  if (mapped) return mapped;
  return (ALL_AGENT_TYPES as readonly string[]).includes(value) ? (value as AgentType) : null;
}

function providerSupportsAgent(provider: GlobalProvider, agentType: AgentType): boolean {
  return (
    !provider.agent_types ||
    provider.agent_types.length === 0 ||
    provider.agent_types.includes(agentType)
  );
}

function resolveProviderEndpoint(provider: GlobalProvider, agentType: AgentType): string {
  return provider.endpoints?.[agentType] ?? provider.base_url ?? '默认端点';
}

function resolveProviderModel(provider: GlobalProvider, agentType: AgentType): string {
  return (
    provider.agent_models?.[agentType] ??
    provider.model ??
    provider.models?.[0]?.model ??
    '未指定模型'
  );
}

function formatModels(models?: ProviderModelEntry[]): string {
  return (models ?? [])
    .map((entry) => (entry.alias ? `${entry.model}:${entry.alias}` : entry.model))
    .join(', ');
}

function parseModels(text: string): ProviderModelEntry[] | undefined {
  const entries = text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [model, alias] = part.split(':').map((segment) => segment.trim());
      return alias ? { model, alias } : { model };
    })
    .filter((entry) => entry.model.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function parseKeyValueText(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function formatKeyValue(record?: Record<string, string>): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function emptyForm(agentType: AgentType): ProviderFormState {
  return {
    name: '',
    apiKey: '',
    baseUrl: '',
    model: '',
    modelsText: '',
    thinking: '',
    agentTypes: [agentType],
    endpoints: {},
    agentModels: {},
    codexWireApi: '',
    codexHeadersText: '',
  };
}

function formFromProvider(
  provider: GlobalProvider,
  fallbackAgentType: AgentType
): ProviderFormState {
  return {
    name: provider.name,
    apiKey: provider.api_key ?? '',
    baseUrl: provider.base_url ?? '',
    model: provider.model ?? '',
    modelsText: formatModels(provider.models),
    thinking: provider.thinking ?? '',
    agentTypes: provider.agent_types?.length ? provider.agent_types : [fallbackAgentType],
    endpoints: provider.endpoints ?? {},
    agentModels: provider.agent_models ?? {},
    codexWireApi: provider.codex?.wire_api ?? '',
    codexHeadersText: formatKeyValue(provider.codex?.http_headers),
  };
}

function formFromPreset(preset: ProviderPreset, fallbackAgentType: AgentType): ProviderFormState {
  const agentEntries = Object.entries(preset.agents ?? {})
    .map(([rawKey, config]) => ({ agentType: normalizeAgentType(rawKey), config }))
    .filter(
      (
        entry
      ): entry is { agentType: AgentType; config: NonNullable<ProviderPreset['agents'][string]> } =>
        entry.agentType != null
    );
  const agentTypes =
    agentEntries.length > 0 ? agentEntries.map((entry) => entry.agentType) : [fallbackAgentType];
  const firstConfig = agentEntries[0]?.config;
  const endpoints: Partial<Record<AgentType, string>> = {};
  const agentModels: Partial<Record<AgentType, string>> = {};
  for (const entry of agentEntries) {
    if (entry.config.base_url) endpoints[entry.agentType] = entry.config.base_url;
    if (entry.config.model) agentModels[entry.agentType] = entry.config.model;
  }
  return {
    name: preset.display_name || preset.name,
    apiKey: '',
    baseUrl: firstConfig?.base_url ?? '',
    model: firstConfig?.model ?? '',
    modelsText: (firstConfig?.models ?? []).join(', '),
    thinking: preset.thinking ?? '',
    agentTypes,
    endpoints,
    agentModels,
    codexWireApi: preset.agents?.codex?.codex_config?.wire_api ?? '',
    codexHeadersText: formatKeyValue(preset.agents?.codex?.codex_config?.http_headers),
  };
}

function formToProvider(form: ProviderFormState, originalName?: string): GlobalProvider {
  const agentTypes = form.agentTypes.length > 0 ? form.agentTypes : undefined;
  const endpoints = Object.fromEntries(
    Object.entries(form.endpoints).filter(([, value]) => value?.trim())
  ) as Partial<Record<AgentType, string>>;
  const agentModels = Object.fromEntries(
    Object.entries(form.agentModels).filter(([, value]) => value?.trim())
  ) as Partial<Record<AgentType, string>>;
  const codexHeaders = parseKeyValueText(form.codexHeadersText);
  const codex =
    form.codexWireApi.trim() || codexHeaders
      ? {
          ...(form.codexWireApi.trim() ? { wire_api: form.codexWireApi.trim() } : {}),
          ...(codexHeaders ? { http_headers: codexHeaders } : {}),
        }
      : undefined;

  return {
    name: form.name.trim() || originalName || '',
    ...(form.apiKey.trim() ? { api_key: form.apiKey.trim() } : {}),
    ...(form.baseUrl.trim() ? { base_url: form.baseUrl.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.thinking.trim() ? { thinking: form.thinking.trim() } : {}),
    ...(agentTypes ? { agent_types: agentTypes } : {}),
    ...(parseModels(form.modelsText) ? { models: parseModels(form.modelsText) } : {}),
    ...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
    ...(Object.keys(agentModels).length > 0 ? { agent_models: agentModels } : {}),
    ...(codex ? { codex } : {}),
  };
}

export const ProviderRuntimeSettingsDialog = ({
  open,
  onOpenChange,
  initialProviderId,
}: Props): React.JSX.Element => {
  const agentType = AGENT_TYPE_BY_CLI_PROVIDER[initialProviderId];
  const harnessLabel = CLI_PROVIDER_LABELS[initialProviderId] ?? initialProviderId;
  const [providers, setProviders] = useState<GlobalProvider[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormState>(() => emptyForm(agentType));

  const compatibleProviders = useMemo(
    () => providers.filter((provider) => providerSupportsAgent(provider, agentType)),
    [agentType, providers]
  );

  const refreshProviders = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await providersApi.list();
      setProviders(result.providers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Provider 失败');
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPresets = useCallback(async (): Promise<void> => {
    setPresetsLoading(true);
    try {
      const result = await providersApi.fetchPresets();
      setPresets(result.providers ?? []);
    } catch {
      setPresets([]);
    } finally {
      setPresetsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setForm(emptyForm(agentType));
    setEditingName(null);
    setFormError(null);
    void refreshProviders();
    void refreshPresets();
  }, [agentType, open, refreshPresets, refreshProviders]);

  const updateForm = (patch: Partial<ProviderFormState>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
    setFormError(null);
  };

  const toggleAgentType = (nextAgentType: AgentType): void => {
    setForm((prev) => {
      const exists = prev.agentTypes.includes(nextAgentType);
      const next = exists
        ? prev.agentTypes.filter((value) => value !== nextAgentType)
        : [...prev.agentTypes, nextAgentType];
      return { ...prev, agentTypes: next.length > 0 ? next : [nextAgentType] };
    });
    setFormError(null);
  };

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim()) {
      setFormError('请填写 Provider 名称');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = formToProvider(form, editingName ?? undefined);
      if (editingName) {
        const existingProvider = providers.find((provider) => provider.name === editingName);
        const { name: _ignoredName, ...patch } = payload;
        await providersApi.update(editingName, {
          ...patch,
          ...(existingProvider?.env ? { env: existingProvider.env } : {}),
          ...(existingProvider?.api_key && !patch.api_key ? { api_key: undefined } : {}),
          ...(existingProvider?.base_url && !patch.base_url ? { base_url: undefined } : {}),
          ...(existingProvider?.model && !patch.model ? { model: undefined } : {}),
          ...(existingProvider?.thinking && !patch.thinking ? { thinking: undefined } : {}),
          ...(existingProvider?.models && !patch.models ? { models: undefined } : {}),
          ...(existingProvider?.endpoints && !patch.endpoints ? { endpoints: undefined } : {}),
          ...(existingProvider?.agent_models && !patch.agent_models
            ? { agent_models: undefined }
            : {}),
          ...(existingProvider?.codex && !patch.codex ? { codex: undefined } : {}),
        });
      } else {
        await providersApi.add(payload);
      }
      setForm(emptyForm(agentType));
      setEditingName(null);
      await refreshProviders();
      emitOpenHermitEvent(OPEN_HERMIT_EVENTS.providersChanged);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存 Provider 失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (providerName: string): Promise<void> => {
    setSaving(true);
    try {
      await providersApi.remove(providerName);
      if (editingName === providerName) {
        setEditingName(null);
        setForm(emptyForm(agentType));
      }
      await refreshProviders();
      emitOpenHermitEvent(OPEN_HERMIT_EVENTS.providersChanged);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除 Provider 失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(96vw,1120px)] max-w-[min(96vw,1120px)] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{harnessLabel} / 全局 Provider</DialogTitle>
          <DialogDescription>
            Provider 是全局资源：先在这里配置网关、模型和适用 Harness，再在团队里选择绑定。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <div className="min-h-0 overflow-y-auto pr-1">
            <Tabs defaultValue="providers" className="min-h-0">
              <TabsList className="mb-3">
                <TabsTrigger value="providers">Provider 库</TabsTrigger>
                <TabsTrigger value="presets">预设</TabsTrigger>
              </TabsList>

              <TabsContent value="providers" className="mt-0 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--color-text)]">
                      全局 Provider
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      当前 {compatibleProviders.length} 个适用于 {harnessLabel}，共{' '}
                      {providers.length} 个。
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void refreshProviders()}
                  >
                    <RefreshCw
                      className={loading ? 'mr-1 size-3.5 animate-spin' : 'mr-1 size-3.5'}
                    />
                    刷新
                  </Button>
                </div>

                {error ? (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                    {error}
                  </div>
                ) : null}

                {loading && providers.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <Loader2 className="size-3 animate-spin" />
                    正在加载 Provider...
                  </div>
                ) : providers.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
                    还没有全局 Provider。可以从右侧新建，或从预设导入。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {providers.map((provider) => {
                      const isCompatible = providerSupportsAgent(provider, agentType);
                      return (
                        <div
                          key={provider.name}
                          className={`rounded-xl border p-3 ${
                            isCompatible
                              ? 'border-[var(--color-border-subtle)] bg-white/[0.025]'
                              : 'border-[var(--color-border)] bg-black/10 opacity-70'
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium text-[var(--color-text)]">
                                  {provider.name}
                                </span>
                                {isCompatible ? (
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] text-emerald-300"
                                  >
                                    适用于当前 Harness
                                  </Badge>
                                ) : null}
                                <Badge variant="outline" className="text-[10px]">
                                  {provider.api_key ? 'Key 已配置' : '未配置 Key'}
                                </Badge>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                                <span>端点：{resolveProviderEndpoint(provider, agentType)}</span>
                                <span>模型：{resolveProviderModel(provider, agentType)}</span>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {(provider.agent_types?.length
                                  ? provider.agent_types
                                  : CORE_AGENT_TYPES
                                ).map((type) => (
                                  <Badge key={type} variant="secondary" className="text-[10px]">
                                    {AGENT_TYPE_LABELS[type] ?? type}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  setEditingName(provider.name);
                                  setForm(formFromProvider(provider, agentType));
                                  setFormError(null);
                                }}
                              >
                                <Pencil className="mr-1 size-3" />
                                编辑
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                disabled={saving}
                                onClick={() => void handleDelete(provider.name)}
                              >
                                <Trash2 className="mr-1 size-3" />
                                删除
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="presets" className="mt-0 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--color-text)]">从预设开始</div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      先选网关预设，再补 Key、模型和适用 Harness。
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={presetsLoading}
                    onClick={() => void refreshPresets()}
                  >
                    <RefreshCw
                      className={presetsLoading ? 'mr-1 size-3.5 animate-spin' : 'mr-1 size-3.5'}
                    />
                    刷新
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    className="rounded-xl border border-dashed border-[var(--color-border)] p-3 text-left transition hover:border-[var(--color-border-emphasis)] hover:bg-white/[0.035]"
                    onClick={() => {
                      setEditingName(null);
                      setForm({ ...emptyForm(agentType), agentTypes: CORE_AGENT_TYPES });
                      setFormError(null);
                    }}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                      <Plus className="size-4" />
                      自定义网关
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      手动配置一个可用于多个 Harness 的 API 网关。
                    </p>
                  </button>
                  {presets.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="rounded-xl border border-[var(--color-border-subtle)] bg-white/[0.025] p-3 text-left transition hover:border-[var(--color-border-emphasis)] hover:bg-white/[0.045]"
                      onClick={() => {
                        setEditingName(null);
                        setForm(formFromPreset(preset, agentType));
                        setFormError(null);
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium text-[var(--color-text)]">
                          {preset.display_name || preset.name}
                        </div>
                        {preset.featured ? <Badge className="text-[10px]">推荐</Badge> : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                        {preset.description_zh ||
                          preset.description ||
                          preset.website ||
                          'Provider 预设'}
                      </p>
                    </button>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div className="min-h-0 overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-white/[0.025] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--color-text)]">
                  {editingName ? `编辑 ${editingName}` : 'Provider 表单'}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  这里配置全局 Provider；团队里只选择启用，不重复填写。
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setEditingName(null);
                  setForm(emptyForm(agentType));
                  setFormError(null);
                }}
              >
                清空
              </Button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>Provider 名称</span>
                  <Input
                    value={form.name}
                    disabled={editingName != null}
                    onChange={(event) => updateForm({ name: event.target.value })}
                    placeholder="NewAPI / n1n.ai / custom"
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>默认模型</span>
                  <Input
                    value={form.model}
                    onChange={(event) => updateForm({ model: event.target.value })}
                    placeholder="claude-sonnet-4 / gpt-4o / gemini-2.5-pro"
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>Base URL</span>
                  <Input
                    value={form.baseUrl}
                    onChange={(event) => updateForm({ baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="space-y-1 text-xs text-[var(--color-text-secondary)]">
                  <span>API Key</span>
                  <Input
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => updateForm({ apiKey: event.target.value })}
                    placeholder="sk-..."
                  />
                </label>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--color-text-secondary)]">
                  适用 Harness
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {ALL_AGENT_TYPES.map((type) => (
                    <label
                      key={type}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-white/[0.03]"
                    >
                      <Checkbox
                        checked={form.agentTypes.includes(type as AgentType)}
                        onCheckedChange={() => toggleAgentType(type as AgentType)}
                      />
                      <span>{AGENT_TYPE_LABELS[type] ?? type}</span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="block space-y-1 text-xs text-[var(--color-text-secondary)]">
                <span>模型列表（逗号或换行分隔，支持 model:alias）</span>
                <textarea
                  value={form.modelsText}
                  onChange={(event) => updateForm({ modelsText: event.target.value })}
                  className="min-h-16 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
                  placeholder="claude-sonnet-4, claude-opus-4:Opus"
                />
              </label>

              <div className="space-y-2">
                <div className="text-xs font-medium text-[var(--color-text-secondary)]">
                  每个 Harness 的覆盖配置
                </div>
                <div className="space-y-2">
                  {form.agentTypes.map((type) => (
                    <div
                      key={type}
                      className="rounded-lg border border-[var(--color-border-subtle)] p-2"
                    >
                      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-text)]">
                        {type === 'claudecode' ? (
                          <ProviderBrandLogo providerId="anthropic" className="size-3.5" />
                        ) : null}
                        {type === 'codex' ? (
                          <ProviderBrandLogo providerId="codex" className="size-3.5" />
                        ) : null}
                        {type === 'gemini' ? (
                          <ProviderBrandLogo providerId="gemini" className="size-3.5" />
                        ) : null}
                        {type === 'opencode' ? (
                          <ProviderBrandLogo providerId="opencode" className="size-3.5" />
                        ) : null}
                        {AGENT_TYPE_LABELS[type] ?? type}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          value={form.endpoints[type] ?? ''}
                          onChange={(event) =>
                            updateForm({
                              endpoints: { ...form.endpoints, [type]: event.target.value },
                            })
                          }
                          placeholder="专用 endpoint（可选）"
                        />
                        <Input
                          value={form.agentModels[type] ?? ''}
                          onChange={(event) =>
                            updateForm({
                              agentModels: { ...form.agentModels, [type]: event.target.value },
                            })
                          }
                          placeholder="专用默认模型（可选）"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {form.agentTypes.includes('codex') ? (
                <div className="space-y-2 rounded-lg border border-[var(--color-border-subtle)] p-3">
                  <div className="text-xs font-medium text-[var(--color-text-secondary)]">
                    Codex 高级配置
                  </div>
                  <Input
                    value={form.codexWireApi}
                    onChange={(event) => updateForm({ codexWireApi: event.target.value })}
                    placeholder="wire_api（可选）"
                  />
                  <textarea
                    value={form.codexHeadersText}
                    onChange={(event) => updateForm({ codexHeadersText: event.target.value })}
                    className="min-h-14 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
                    placeholder="HTTP headers，每行 KEY=VALUE"
                  />
                </div>
              ) : null}

              <label className="block space-y-1 text-xs text-[var(--color-text-secondary)]">
                <span>Thinking 设置（可选）</span>
                <Input
                  value={form.thinking}
                  onChange={(event) => updateForm({ thinking: event.target.value })}
                  placeholder="enabled / disabled / 留空"
                />
              </label>

              {formError ? <div className="text-xs text-red-400">{formError}</div> : null}

              <div className="flex justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-3">
                <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
                  关闭
                </Button>
                <Button
                  className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                  {editingName ? '保存修改' : '保存 Provider'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

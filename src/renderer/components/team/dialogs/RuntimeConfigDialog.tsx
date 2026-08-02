import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { AGENT_TYPE_LABELS } from '@renderer/components/team/HarnessCards';
import { HarnessSelect } from '@renderer/components/team/HarnessSelect';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import { Loader2, Plug2, Settings2, Wifi, WifiOff } from 'lucide-react';

import {
  buildPlatformAllowUpdatePayload,
  getPlatformAllowValue,
  readStringRecord,
  withPlatformAllowValue,
} from './platformAllowUtils';
import {
  type PlatformBindingCompleteOptions,
  PlatformBindingContent,
} from './PlatformBindingDialog';
import { platformMeta } from './platformMeta';

import type {
  HermitBridgeAgentType,
  HermitBridgeProjectPlatform,
} from '@shared/types/hermitBridge';
import type { TeamUpdateConfigRequest } from '@shared/types/team';

// ── Section wrapper ──────────────────────────────────────────
const FormSection = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element => {
  return (
    <div className="bg-[var(--color-surface-raised)]/55 relative overflow-hidden rounded-xl border border-[var(--color-border-subtle)] p-3 shadow-sm shadow-black/10">
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent" />
      <h3 className="text-sm font-medium text-[var(--color-text)]">{title}</h3>
      {description && (
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {description}
        </p>
      )}
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
};

const inputCls =
  'w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent-border)] focus:ring-1 focus:ring-[var(--color-accent-border)]';
const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-text-secondary)]';

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '跳过权限确认' },
  { value: 'plan', label: '计划模式' },
] as const;

function canonicalPlatformType(type: string): string {
  return type === 'wechat' ? 'weixin' : type;
}

function getPlatformLabel(type: string): string {
  const canonical = canonicalPlatformType(type);
  if (canonical === 'feishu' || canonical === 'lark') return '飞书 / Lark';
  if (canonical === 'weixin') return '微信';
  return platformMeta[canonical]?.label ?? type;
}

function getPlatformAllowPlaceholder(platformType: string, kind: 'from' | 'chat'): string {
  const fieldKey = kind === 'from' ? 'allow_from' : 'allow_chat';
  const field = platformMeta[canonicalPlatformType(platformType)]?.fields.find(
    (item) => item.key === fieldKey
  );
  if (field?.placeholder) return `留空表示未单独配置；${field.placeholder}`;
  return kind === 'from'
    ? '留空表示未单独配置；输入 * 表示允许所有用户'
    : '留空表示未单独配置；输入 * 表示允许所有群聊/频道';
}

function uniquePlatformTypes(platforms: HermitBridgeProjectPlatform[]): string[] {
  return [
    ...new Set(
      platforms
        .map((platform) => platform.type)
        .filter((type) => Boolean(type) && type !== 'bridge')
    ),
  ];
}

const BoundPlatformList = ({
  platforms,
}: {
  platforms: HermitBridgeProjectPlatform[];
}): React.JSX.Element => {
  if (platforms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
        暂无已绑定渠道。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {platforms.map((platform) => (
        <div
          key={`${platform.type}:${String(platform.connected)}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Plug2 className="size-3.5" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[var(--color-text)]">
                {getPlatformLabel(platform.type)}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                {platform.type}
              </div>
            </div>
          </div>
          <span
            className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
              platform.connected
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'bg-white/5 text-[var(--color-text-muted)]'
            }`}
          >
            {platform.connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {platform.connected ? '已连接' : '已绑定未连接'}
          </span>
        </div>
      ))}
    </div>
  );
};

interface RuntimeConfigDialogProps {
  open: boolean;
  teamName: string;
  onClose: () => void;
}

export const RuntimeConfigDialog = ({
  open,
  teamName,
  onClose,
}: RuntimeConfigDialogProps): React.JSX.Element => {
  const isAdminTeam = teamName === SYSTEM_MANAGER_TEAM_NAME;
  const { data, fetchTeams, selectTeam } = useStore((s) => ({
    data: s.selectedTeamName === teamName ? s.selectedTeamData : null,
    fetchTeams: s.fetchTeams,
    selectTeam: s.selectTeam,
  }));

  // ── Derived defaults ─────────────────────────────────────────
  const defaults = useMemo(() => {
    const cfg = data?.config;
    const d = data as Record<string, unknown> | null;
    const rawSettings = data?.settings ?? {};
    return {
      agentType: cfg?.agentType ?? (d?.harness as string | undefined) ?? 'claudecode',
      workDir: cfg?.projectPath ?? (d?.workDir as string | undefined) ?? '',
      permissionMode: cfg?.permissionMode ?? (d?.permissionMode as string | undefined) ?? 'default',
      disabledCommands: Array.isArray(cfg?.disabledCommands) ? cfg.disabledCommands : [],
      managedSources:
        cfg?.managedSources ??
        (typeof rawSettings.admin_from === 'string' ? rawSettings.admin_from : '*'),
      language:
        cfg?.language ?? (typeof rawSettings.language === 'string' ? rawSettings.language : 'zh'),
      showContextIndicator:
        cfg?.showContextIndicator ??
        (typeof rawSettings.show_context_indicator === 'boolean'
          ? rawSettings.show_context_indicator
          : true),
      replyFooter:
        cfg?.replyFooter ??
        (typeof rawSettings.reply_footer === 'boolean' ? rawSettings.reply_footer : true),
      injectSender:
        cfg?.injectSender ??
        (typeof rawSettings.inject_sender === 'boolean' ? rawSettings.inject_sender : false),
      resetOnIdleMins: typeof d?.resetOnIdleMins === 'number' ? d.resetOnIdleMins : 0,
      platformAllowFrom:
        cfg?.platformAllowFrom ?? readStringRecord(rawSettings.platform_allow_from),
      platformAllowChat:
        cfg?.platformAllowChat ?? readStringRecord(rawSettings.platform_allow_chat),
      providerRefs: data?.providerRefs ?? [],
      globalProviders: data?.globalProviders ?? [],
      platformOptions:
        (d?.platformOptions as Record<string, Record<string, string>> | undefined) ?? {},
      bindProject: (d?.bindProject as string | undefined) ?? teamName,
    };
  }, [data, teamName]);

  // ── Local form state ─────────────────────────────────────────
  const [agentType, setAgentType] = useState(defaults.agentType);
  const [permissionMode, setPermissionMode] = useState(defaults.permissionMode);
  const [workDir, setWorkDir] = useState(defaults.workDir);
  const [disabledCommandsInput, setDisabledCommandsInput] = useState(
    defaults.disabledCommands.join(', ')
  );
  const [providerRef, setProviderRef] = useState(defaults.providerRefs[0] ?? '');
  const [platformAllowFrom, setPlatformAllowFrom] = useState(defaults.platformAllowFrom);
  const [platformAllowChat, setPlatformAllowChat] = useState(defaults.platformAllowChat);
  const [language, setLanguage] = useState(defaults.language);
  const [managedSources, setManagedSources] = useState(defaults.managedSources);
  const [showContextIndicator, setShowContextIndicator] = useState(defaults.showContextIndicator);
  const [replyFooter, setReplyFooter] = useState(defaults.replyFooter);
  const [injectSender, setInjectSender] = useState(defaults.injectSender);
  const [resetOnIdleMins, setResetOnIdleMins] = useState(defaults.resetOnIdleMins);
  const [platformOpts, setPlatformOpts] = useState(defaults.platformOptions);
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'restarting' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const saving = savePhase === 'saving' || savePhase === 'restarting';
  const [bindingStep, setBindingStep] = useState<'runtime' | 'bind'>('runtime');
  const [bindingSavePending, setBindingSavePending] = useState(false);

  const defaultsRef = useRef(defaults);
  if (defaults.agentType) defaultsRef.current = defaults;

  // ── Reset form when dialog opens ─────────────────────────────
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!open || prevOpenRef.current) {
      prevOpenRef.current = open;
      return;
    }
    prevOpenRef.current = true;
    const d = defaultsRef.current;
    setSavePhase('idle');
    setError(null);
    setBindingStep('runtime');
    setBindingSavePending(false);
    setAgentType(d.agentType);
    setPermissionMode(d.permissionMode);
    setWorkDir(d.workDir);
    setDisabledCommandsInput(d.disabledCommands.join(', '));
    setProviderRef(d.providerRefs[0] ?? '');
    setPlatformAllowFrom(d.platformAllowFrom);
    setPlatformAllowChat(d.platformAllowChat);
    setLanguage(d.language);
    setManagedSources(d.managedSources);
    setShowContextIndicator(d.showContextIndicator);
    setReplyFooter(d.replyFooter);
    setInjectSender(d.injectSender);
    setResetOnIdleMins(d.resetOnIdleMins);
    setPlatformOpts(d.platformOptions);
  }, [open]);

  // ── Computed ─────────────────────────────────────────────────
  const compatibleProviders = useMemo(
    () =>
      defaults.globalProviders.filter(
        (p) =>
          !p.agent_types ||
          p.agent_types.length === 0 ||
          (p.agent_types as string[]).includes(agentType)
      ),
    [defaults.globalProviders, agentType]
  );

  const boundPlatforms = useMemo<HermitBridgeProjectPlatform[]>(
    () => data?.platforms ?? [],
    [data?.platforms]
  );
  const platformTypes = useMemo(() => uniquePlatformTypes(boundPlatforms), [boundPlatforms]);

  const updatePlatformAllowValue = (
    kind: 'from' | 'chat',
    platformType: string,
    value: string
  ): void => {
    markRuntimeEdited();
    const setter = kind === 'from' ? setPlatformAllowFrom : setPlatformAllowChat;
    setter((current) => withPlatformAllowValue(current, platformType, value));
  };

  const markRuntimeEdited = (): void => {
    setError(null);
    setSavePhase((phase) => (phase === 'done' ? 'idle' : phase));
  };

  const toggleProviderRef = (providerName: string): void => {
    markRuntimeEdited();
    setProviderRef(providerRef === providerName ? '' : providerName);
  };

  // ── Save ─────────────────────────────────────────────────────
  const buildConfigPayload = (): TeamUpdateConfigRequest => {
    const disabledCommands = disabledCommandsInput
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    const platformAllowFromPatch = buildPlatformAllowUpdatePayload(
      defaults.platformAllowFrom,
      platformAllowFrom
    );
    const platformAllowChatPatch = buildPlatformAllowUpdatePayload(
      defaults.platformAllowChat,
      platformAllowChat
    );

    return {
      agentType: agentType.trim() || undefined,
      workDir: workDir.trim() || undefined,
      permissionMode: permissionMode.trim() || undefined,
      disabledCommands,
      platformAllowFrom: platformAllowFromPatch,
      platformAllowChat: platformAllowChatPatch,
      language: language.trim() || undefined,
      managedSources: managedSources.trim() || undefined,
      showContextIndicator,
      replyFooter,
      injectSender,
      providerRefs: providerRef ? [providerRef] : [],
      resetOnIdleMins,
      platformOptions: platformOpts,
    };
  };

  const saveRuntimeConfig = async (): Promise<void> => {
    await api.teams.updateConfig(teamName, buildConfigPayload());
    await Promise.all([fetchTeams(), selectTeam(teamName)]);
  };

  const handleSave = (): void => {
    if (savePhase !== 'idle') return;

    setSavePhase('saving');
    setError(null);

    void (async () => {
      try {
        await saveRuntimeConfig();

        if (isAdminTeam) {
          void Promise.all([fetchTeams(), selectTeam(teamName)]);
          setSavePhase('done');
        } else {
          setSavePhase('restarting');
          try {
            await api.ccSettings.restart();
            setSavePhase('done');
          } catch (restartErr) {
            setError(
              `配置已保存，但重启失败：${restartErr instanceof Error ? restartErr.message : '未知错误'}`
            );
            setSavePhase('idle');
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败');
        setSavePhase('idle');
      }
    })();
  };

  const handleStartBinding = (): void => {
    if (saving || bindingSavePending) return;

    setBindingSavePending(true);
    setError(null);
    void (async () => {
      try {
        await saveRuntimeConfig();
        setBindingStep('bind');
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存配置失败，无法进入渠道绑定');
      } finally {
        setBindingSavePending(false);
      }
    })();
  };

  const handleBindingComplete = (options?: PlatformBindingCompleteOptions): void => {
    if (saving) return;

    setSavePhase(options?.restartHandled ? 'saving' : 'restarting');
    setError(null);
    void (async () => {
      // cc-connect 注册新渠道 + 重启有传播延迟，绑定后立即拉一次往往拿到绑定前的旧数据。
      // 参考 TeamListView 的延迟二次刷新，确保运行时编辑框与团队列表及时反映新绑定。
      const refreshAfterBinding = (delayMs: number): void => {
        window.setTimeout(() => {
          void Promise.all([fetchTeams(), selectTeam(teamName)]).catch(() => undefined);
        }, delayMs);
      };
      try {
        if (!options?.restartHandled && !isAdminTeam) {
          await api.ccSettings.restart();
        }
        await Promise.all([fetchTeams(), selectTeam(teamName)]);
        refreshAfterBinding(1200);
        refreshAfterBinding(3500);
        setBindingStep('runtime');
        setSavePhase('done');
      } catch (err) {
        setError(`渠道已绑定，但重启失败：${err instanceof Error ? err.message : '未知错误'}`);
        setBindingStep('runtime');
        setSavePhase('idle');
        void Promise.all([fetchTeams(), selectTeam(teamName)]).catch(() => undefined);
        refreshAfterBinding(1200);
        refreshAfterBinding(3500);
      }
    })();
  };

  const saveLabel =
    savePhase === 'done'
      ? '已完成'
      : savePhase === 'restarting'
        ? '正在重启...'
        : savePhase === 'saving'
          ? '保存中...'
          : isAdminTeam
            ? '保存'
            : '保存并重启';

  return (
    <Dialog
      open={saving || bindingSavePending ? true : open}
      onOpenChange={(nextOpen) => {
        if (saving || bindingSavePending) return;
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 size={16} />
            运行时配置
          </DialogTitle>
          <DialogDescription>
            修改 Agent 类型、渠道、Loop 动态设置等运行时参数。部分变更需要重启服务。
          </DialogDescription>
        </DialogHeader>

        {bindingStep === 'bind' ? (
          <PlatformBindingContent
            projectName={defaults.bindProject}
            workDir={workDir}
            agentType={agentType}
            platformAllowFrom={platformAllowFrom}
            platformAllowChat={platformAllowChat}
            onComplete={handleBindingComplete}
            onCancel={() => setBindingStep('runtime')}
          />
        ) : (
          <div className="space-y-4">
            {/* Agent & 权限 */}
            <FormSection title="Agent & 权限">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className={labelCls}>Agent 类型</label>
                  <HarnessSelect
                    value={agentType as HermitBridgeAgentType}
                    onChange={(v) => {
                      markRuntimeEdited();
                      setAgentType(v);
                    }}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className={labelCls}>权限模式</label>
                  <select
                    value={permissionMode}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setPermissionMode(e.target.value);
                    }}
                    className={inputCls}
                  >
                    {PERMISSION_MODE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>工作目录</label>
                <input
                  type="text"
                  value={workDir}
                  onChange={(e) => {
                    markRuntimeEdited();
                    setWorkDir(e.target.value);
                  }}
                  className={`${inputCls} font-mono`}
                  placeholder="/Users/you/code/project"
                />
              </div>
            </FormSection>

            {/* 渠道 */}
            <FormSection title="渠道" description="绑定外部协作平台（飞书、Telegram 等）。">
              <BoundPlatformList platforms={boundPlatforms} />
              {platformTypes.length > 0 ? (
                <div className="space-y-2">
                  {platformTypes.map((platformType) => {
                    const meta = platformMeta[canonicalPlatformType(platformType)];
                    const sessionFields =
                      meta?.fields.filter(
                        (f) =>
                          f.group === 'advanced' &&
                          f.key !== 'allow_from' &&
                          f.key !== 'allow_chat' &&
                          !f.required
                      ) ?? [];
                    return (
                      <details
                        key={platformType}
                        className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2"
                      >
                        <summary className="cursor-pointer text-xs font-medium text-[var(--color-text)]">
                          {getPlatformLabel(platformType)} 入口权限 & 会话绑定
                        </summary>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <div>
                            <label className={labelCls}>允许用户</label>
                            <input
                              type="text"
                              value={getPlatformAllowValue(platformAllowFrom, platformType)}
                              onChange={(event) =>
                                updatePlatformAllowValue('from', platformType, event.target.value)
                              }
                              className={`${inputCls} font-mono`}
                              placeholder={getPlatformAllowPlaceholder(platformType, 'from')}
                            />
                          </div>
                          <div>
                            <label className={labelCls}>允许群聊/频道</label>
                            <input
                              type="text"
                              value={getPlatformAllowValue(platformAllowChat, platformType)}
                              onChange={(event) =>
                                updatePlatformAllowValue('chat', platformType, event.target.value)
                              }
                              className={`${inputCls} font-mono`}
                              placeholder={getPlatformAllowPlaceholder(platformType, 'chat')}
                            />
                          </div>
                        </div>
                        {sessionFields.length > 0 && (
                          <div className="mt-3 space-y-2">
                            <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                              会话绑定
                            </p>
                            <div className="space-y-1">
                              {(() => {
                                const canonical = canonicalPlatformType(platformType);
                                const currentOpts = platformOpts[canonical] ?? {};
                                const exclusiveKeys = [
                                  'thread_isolation',
                                  'share_session_in_channel',
                                ];
                                const modeFields = sessionFields.filter(
                                  (f) => exclusiveKeys.includes(f.key) && f.type === 'boolean'
                                );
                                const independentBoolFields = sessionFields.filter(
                                  (f) => !exclusiveKeys.includes(f.key) && f.type === 'boolean'
                                );
                                const textFields = sessionFields.filter(
                                  (f) => f.type !== 'boolean'
                                );

                                return (
                                  <>
                                    {modeFields.map((field) => (
                                      <div key={field.key}>
                                        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                                          <input
                                            type="checkbox"
                                            checked={currentOpts[field.key] === 'true'}
                                            onChange={(e) => {
                                              markRuntimeEdited();
                                              setPlatformOpts((prev) => {
                                                const updated = { ...prev[canonical] };
                                                if (e.target.checked) {
                                                  for (const k of exclusiveKeys)
                                                    updated[k] = 'false';
                                                  updated[field.key] = 'true';
                                                } else {
                                                  updated[field.key] = 'false';
                                                }
                                                return { ...prev, [canonical]: updated };
                                              });
                                            }}
                                            className="size-3.5"
                                          />
                                          {field.label}
                                        </label>
                                        {field.hint && (
                                          <p className="mt-0.5 pl-6 text-[10px] text-[var(--color-text-muted)]">
                                            {field.hint}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                    {modeFields.length > 0 && (
                                      <p className="pl-1 text-[10px] text-[var(--color-text-muted)]">
                                        Thread 隔离与共享群会话互斥，勾选一项会自动取消另一项。
                                      </p>
                                    )}
                                    {independentBoolFields.map((field) => (
                                      <div key={field.key}>
                                        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                                          <input
                                            type="checkbox"
                                            checked={currentOpts[field.key] === 'true'}
                                            onChange={(e) => {
                                              markRuntimeEdited();
                                              setPlatformOpts((prev) => ({
                                                ...prev,
                                                [canonical]: {
                                                  ...prev[canonical],
                                                  [field.key]: e.target.checked ? 'true' : 'false',
                                                },
                                              }));
                                            }}
                                            className="size-3.5"
                                          />
                                          {field.label}
                                        </label>
                                        {field.hint && (
                                          <p className="mt-0.5 pl-6 text-[10px] text-[var(--color-text-muted)]">
                                            {field.hint}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                    {textFields.map((field) => (
                                      <div key={field.key}>
                                        <label className={labelCls}>{field.label}</label>
                                        <input
                                          type="text"
                                          value={currentOpts[field.key] ?? ''}
                                          onChange={(e) => {
                                            markRuntimeEdited();
                                            setPlatformOpts((prev) => ({
                                              ...prev,
                                              [canonical]: {
                                                ...prev[canonical],
                                                [field.key]: e.target.value,
                                              },
                                            }));
                                          }}
                                          className={inputCls}
                                          placeholder={field.placeholder ?? ''}
                                        />
                                        {field.hint && (
                                          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                                            {field.hint}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </details>
                    );
                  })}
                </div>
              ) : null}
              <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                按渠道控制运行时入口。留空代表未单独配置，不等于允许所有；只有显式填写 *
                才表示放行所有。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartBinding}
                disabled={saving || bindingSavePending}
              >
                {bindingSavePending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {bindingSavePending ? '保存配置中...' : '绑定新渠道'}
              </Button>
            </FormSection>

            {/* Loop 动态设置 — 语言/管理来源/消息格式，保存即生效 (#21) */}
            <FormSection
              title="Loop 动态设置"
              description="语言、管理来源与消息格式，保存即生效（无需重启）。"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className={labelCls}>语言</label>
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setLanguage(e.target.value);
                    }}
                    className={inputCls}
                    placeholder="zh"
                    data-testid="loop-language"
                  />
                </div>
                <div>
                  <label className={labelCls}>管理来源</label>
                  <input
                    type="text"
                    value={managedSources}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setManagedSources(e.target.value);
                    }}
                    className={inputCls}
                    placeholder="user1,user2 或 *"
                    data-testid="loop-managed-sources"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={showContextIndicator}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setShowContextIndicator(e.target.checked);
                    }}
                    className="size-3.5"
                    data-testid="loop-show-context-indicator"
                  />
                  上下文指示
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={replyFooter}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setReplyFooter(e.target.checked);
                    }}
                    className="size-3.5"
                    data-testid="loop-reply-footer"
                  />
                  回复尾部信息
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={injectSender}
                    onChange={(e) => {
                      markRuntimeEdited();
                      setInjectSender(e.target.checked);
                    }}
                    className="size-3.5"
                    data-testid="loop-inject-sender"
                  />
                  注入发送者
                </label>
              </div>
            </FormSection>

            {/* 会话管理 */}
            <FormSection title="会话管理" description="控制会话生命周期和自动轮转行为。">
              <div>
                <label className={labelCls}>空闲自动轮转（分钟）</label>
                <input
                  type="number"
                  min={0}
                  value={resetOnIdleMins}
                  onChange={(e) => {
                    markRuntimeEdited();
                    setResetOnIdleMins(Math.max(0, Number(e.target.value) || 0));
                  }}
                  className={inputCls}
                  placeholder="0 = 不自动轮转"
                />
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  会话空闲超过此时间后自动切换到新会话，旧会话保留可通过 /list 查看。设为 0
                  表示不自动轮转。
                </p>
              </div>
            </FormSection>

            {/* Provider */}
            <div className="bg-[var(--color-surface-raised)]/55 relative overflow-hidden rounded-xl border border-[var(--color-border-subtle)] p-3 shadow-sm shadow-black/10">
              <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent" />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-[var(--color-text)]">Provider（可选）</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    留空时使用本机{' '}
                    {AGENT_TYPE_LABELS[agentType as HermitBridgeAgentType] ?? agentType} 默认配置。
                  </p>
                </div>
                {providerRef ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-white/5"
                    onClick={() => {
                      markRuntimeEdited();
                      setProviderRef('');
                    }}
                  >
                    使用本机默认
                  </button>
                ) : null}
              </div>
              <div className="mt-3 space-y-2">
                {compatibleProviders.length > 0 ? (
                  compatibleProviders.map((provider) => {
                    const checked = providerRef === provider.name;
                    const at = agentType as HermitBridgeAgentType;
                    const endpoint = provider.endpoints?.[at] ?? provider.base_url ?? '默认端点';
                    const model =
                      provider.agent_models?.[at] ??
                      provider.model ??
                      provider.models?.[0]?.model ??
                      '未指定模型';
                    return (
                      <button
                        key={provider.name}
                        type="button"
                        onClick={() => toggleProviderRef(provider.name)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          checked
                            ? 'shadow-[var(--color-accent-glow)]/20 border-[var(--color-accent-border)] bg-[var(--color-accent-muted)] shadow-sm'
                            : 'border-[var(--color-border-subtle)] bg-black/10 hover:border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-[var(--color-text)]">
                              {provider.name}
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                              {model} · {endpoint}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                              checked
                                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                                : 'bg-white/5 text-[var(--color-text-muted)]'
                            }`}
                          >
                            {checked ? '已绑定' : '可绑定'}
                          </span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
                    暂无适用于 {AGENT_TYPE_LABELS[agentType as HermitBridgeAgentType] ?? agentType}{' '}
                    的全局 Provider。
                  </div>
                )}
              </div>
            </div>

            {/* 高级 */}
            <FormSection title="高级">
              <div>
                <label className={labelCls}>已禁用命令</label>
                <input
                  type="text"
                  value={disabledCommandsInput}
                  onChange={(e) => {
                    markRuntimeEdited();
                    setDisabledCommandsInput(e.target.value);
                  }}
                  className={inputCls}
                  placeholder="restart, upgrade, cron"
                />
              </div>
            </FormSection>

            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
        )}

        {bindingStep === 'runtime' && (
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={saving || bindingSavePending}
            >
              {savePhase === 'done' ? '关闭' : '取消'}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || bindingSavePending || savePhase === 'done'}
              className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            >
              {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {saveLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

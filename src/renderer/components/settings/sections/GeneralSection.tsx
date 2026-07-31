/**
 * GeneralSection - General settings including startup, appearance, browser access, and local Claude root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import { Combobox } from '@renderer/components/ui/combobox';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFullResetState } from '@renderer/store/utils/stateResetHelpers';
import { AGENT_LANGUAGE_OPTIONS, resolveLanguageName } from '@shared/utils/agentLanguage';
import { Bot, Check, Copy, Gauge, Loader2, Palette, Server, Shield } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SettingRow, SettingsSectionCard, SettingsSelect, SettingsToggle } from '../components';

import type { SafeConfig } from '../hooks/useSettingsConfig';
import type { ClaudeRootInfo, WslClaudeRootCandidate } from '@shared/types';
import type { HttpServerStatus } from '@shared/types/api';
import type { AppConfig } from '@shared/types/notifications';

const THEME_OPTIONS = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
] as const;

const CC_LOG_LEVEL_OPTIONS = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
];

const CC_ATTACHMENT_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
];

interface CcGlobalSettingsState {
  language: string;
  attachment_send: string;
  log_level: string;
  idle_timeout_mins: number;
  thinking_messages: boolean;
  thinking_max_len: number;
  tool_messages: boolean;
  tool_max_len: number;
  stream_preview_enabled: boolean;
  stream_preview_interval_ms: number;
  rate_limit_max_messages: number;
  rate_limit_window_secs: number;
}

/** Compact number input for SettingRow right side */
const CompactNum = ({
  value,
  onChange,
  onSave,
  min,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  onSave: () => void;
  min?: number;
  className?: string;
}): React.JSX.Element => (
  <input
    type="number"
    min={min}
    value={value}
    onChange={(e) => onChange(Number(e.target.value) || 0)}
    onBlur={onSave}
    onKeyDown={(e) => {
      if (e.key === 'Enter') onSave();
    }}
    className={cn(
      'h-8 w-24 rounded-md border bg-transparent px-2 text-right text-xs tabular-nums',
      'focus:outline-none focus:ring-1 focus:ring-[var(--color-border-emphasis)]',
      className
    )}
    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
  />
);

interface GeneralSectionProps {
  readonly safeConfig: SafeConfig;
  readonly saving: boolean;
  readonly onGeneralToggle: (key: keyof AppConfig['general'], value: boolean) => void;
  readonly onThemeChange: (value: 'dark' | 'light' | 'system') => void;
  readonly onLanguageChange: (value: string) => void;
}

export const GeneralSection = ({
  safeConfig,
  saving,
  onGeneralToggle,
  onThemeChange,
  onLanguageChange,
}: GeneralSectionProps): React.JSX.Element => {
  const [serverStatus, setServerStatus] = useState<HttpServerStatus>({
    running: false,
    port: 5680,
  });
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { connectionMode, fetchProjects, fetchRepositoryGroups } = useStore(
    useShallow((s) => ({
      connectionMode: s.connectionMode,
      fetchProjects: s.fetchProjects,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
    }))
  );

  const [claudeRootInfo, setClaudeRootInfo] = useState<ClaudeRootInfo | null>(null);
  const [updatingClaudeRoot, setUpdatingClaudeRoot] = useState(false);
  const [claudeRootError, setClaudeRootError] = useState<string | null>(null);
  const [findingWslRoots, setFindingWslRoots] = useState(false);
  const [wslCandidates, setWslCandidates] = useState<WslClaudeRootCandidate[]>([]);
  const [showWslModal, setShowWslModal] = useState(false);
  const [ccSettings, setCcSettings] = useState<CcGlobalSettingsState>({
    language: 'zh',
    attachment_send: '',
    log_level: 'info',
    idle_timeout_mins: 120,
    thinking_messages: true,
    thinking_max_len: 300,
    tool_messages: true,
    tool_max_len: 500,
    stream_preview_enabled: true,
    stream_preview_interval_ms: 1500,
    rate_limit_max_messages: 20,
    rate_limit_window_secs: 60,
  });
  const [ccSettingsLoading, setCcSettingsLoading] = useState(false);

  useEffect(() => {
    void api.httpServer
      .getStatus()
      .then(setServerStatus)
      .catch((error: unknown) => {
        setServerError(error instanceof Error ? error.message : '获取服务端状态失败');
      });
  }, []);

  const loadClaudeRootInfo = useCallback(async () => {
    try {
      const info = await api.config.getClaudeRootInfo();
      setClaudeRootInfo(info);
    } catch (error) {
      setClaudeRootError(error instanceof Error ? error.message : '加载本地 Claude 根目录设置失败');
    }
  }, []);

  useEffect(() => {
    void loadClaudeRootInfo();
  }, [loadClaudeRootInfo]);

  const loadCcSettings = useCallback(async () => {
    setCcSettingsLoading(true);
    try {
      const settings = await api.ccSettings.get();
      setCcSettings((prev) => ({ ...prev, ...(settings as Partial<CcGlobalSettingsState>) }));
    } catch {
      // best-effort
    } finally {
      setCcSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCcSettings();
  }, [loadCcSettings]);

  const patchCcSettings = useCallback((patch: Partial<CcGlobalSettingsState>) => {
    setCcSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const autoSaveCcSetting = useCallback(
    async <K extends keyof CcGlobalSettingsState>(key: K, value: CcGlobalSettingsState[K]) => {
      patchCcSettings({ [key]: value });
      try {
        await api.ccSettings.patch({ [key]: value } as unknown as Record<string, unknown>);
      } catch {
        // silent
      }
    },
    [patchCcSettings]
  );

  const handleServerToggle = useCallback(async (enabled: boolean) => {
    setServerLoading(true);
    setServerError(null);
    try {
      const status = enabled ? await api.httpServer.start() : await api.httpServer.stop();
      setServerStatus(status);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : '切换服务端模式失败');
    } finally {
      setServerLoading(false);
    }
  }, []);

  const serverUrl = `${window.location.protocol}//${window.location.hostname}:${serverStatus.port}`;

  const handleCopyUrl = useCallback(() => {
    void navigator.clipboard.writeText(serverUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [serverUrl]);

  const resetWorkspaceForRootChange = useCallback((): void => {
    useStore.setState({
      projects: [],
      repositoryGroups: [],
      openTabs: [],
      activeTabId: null,
      selectedTabIds: [],
      paneLayout: {
        panes: [
          {
            id: 'pane-default',
            tabs: [],
            activeTabId: null,
            selectedTabIds: [],
            widthFraction: 1,
          },
        ],
        focusedPaneId: 'pane-default',
      },
      ...getFullResetState(),
    });
  }, []);

  const applyClaudeRootPath = useCallback(
    async (claudeRootPath: string | null): Promise<void> => {
      try {
        setUpdatingClaudeRoot(true);
        setClaudeRootError(null);

        await api.config.update('general', { claudeRootPath });
        await loadClaudeRootInfo();

        if (connectionMode === 'local') {
          resetWorkspaceForRootChange();
          await Promise.all([fetchProjects(), fetchRepositoryGroups()]);
        }
      } catch (error) {
        setClaudeRootError(error instanceof Error ? error.message : '更新 Claude 根目录失败');
      } finally {
        setUpdatingClaudeRoot(false);
      }
    },
    [
      connectionMode,
      fetchProjects,
      fetchRepositoryGroups,
      loadClaudeRootInfo,
      resetWorkspaceForRootChange,
    ]
  );

  const handleSelectClaudeRootFolder = useCallback(async (): Promise<void> => {
    setClaudeRootError(null);

    const selection = await api.config.selectClaudeRootFolder();
    if (!selection) {
      return;
    }

    if (!selection.isClaudeDirName) {
      const proceed = await confirm({
        title: '所选目录不是 .claude',
        message: `当前目录名为 "${selection.path.split(/[\\/]/).pop() ?? selection.path}"，而不是 ".claude"。仍要继续吗？`,
        confirmLabel: '继续使用',
      });
      if (!proceed) {
        return;
      }
    }

    if (!selection.hasProjectsDir) {
      const proceed = await confirm({
        title: '未发现 projects 目录',
        message: '该目录中不包含 "projects" 子目录。仍要继续吗？',
        confirmLabel: '继续使用',
      });
      if (!proceed) {
        return;
      }
    }

    await applyClaudeRootPath(selection.path);
  }, [applyClaudeRootPath]);

  const handleResetClaudeRoot = useCallback(async (): Promise<void> => {
    await applyClaudeRootPath(null);
  }, [applyClaudeRootPath]);

  const applyWslCandidate = useCallback(
    async (candidate: WslClaudeRootCandidate): Promise<void> => {
      if (!candidate.hasProjectsDir) {
        const proceed = await confirm({
          title: 'WSL 路径缺少 projects 目录',
          message: `"${candidate.path}" 中未发现 "projects" 子目录。仍要继续吗？`,
          confirmLabel: '继续使用',
        });
        if (!proceed) {
          return;
        }
      }

      await applyClaudeRootPath(candidate.path);
      setShowWslModal(false);
    },
    [applyClaudeRootPath]
  );

  const handleUseWslForClaude = useCallback(async (): Promise<void> => {
    try {
      setFindingWslRoots(true);
      setClaudeRootError(null);
      const candidates = await api.config.findWslClaudeRoots();
      setWslCandidates(candidates);

      if (candidates.length === 0) {
        const pickManually = await confirm({
          title: '未检测到 WSL Claude 路径',
          message: '未能自动发现包含 Claude 数据的 WSL 发行版路径。是否手动选择目录？',
          confirmLabel: '选择目录',
        });
        if (pickManually) {
          await handleSelectClaudeRootFolder();
        }
        return;
      }

      const candidatesWithProjects = candidates.filter((candidate) => candidate.hasProjectsDir);
      if (candidatesWithProjects.length === 1) {
        await applyWslCandidate(candidatesWithProjects[0]);
        return;
      }

      setShowWslModal(true);
    } catch (error) {
      setClaudeRootError(error instanceof Error ? error.message : '检测 WSL Claude 根目录路径失败');
    } finally {
      setFindingWslRoots(false);
    }
  }, [applyWslCandidate, handleSelectClaudeRootFolder]);

  const isCustomClaudeRoot = Boolean(claudeRootInfo?.customPath);
  const resolvedClaudeRootPath = claudeRootInfo?.resolvedPath ?? '~/.claude';
  const defaultClaudeRootPath = claudeRootInfo?.defaultPath ?? '~/.claude';
  const isWindowsStyleDefaultPath =
    /^[a-zA-Z]:\\/.test(defaultClaudeRootPath) || defaultClaudeRootPath.startsWith('\\\\');

  const agentLanguageDescription = useMemo(() => {
    const current = safeConfig.general.agentLanguage ?? 'system';
    if (current === 'system') {
      const browserLang = navigator.language;
      const primaryCode = browserLang.includes('-') ? browserLang.split('-')[0] : browserLang;
      const detected = resolveLanguageName('system', browserLang);
      const detectedFlag = AGENT_LANGUAGE_OPTIONS.find((o) => o.value === primaryCode)?.flag ?? '';
      const flagPrefix = detectedFlag ? `${detectedFlag} ` : '';
      return `Agent 通信语言（当前检测：${flagPrefix}${detected}）`;
    }
    return 'Agent 通信语言';
  }, [safeConfig.general.agentLanguage]);

  const languageComboboxOptions = useMemo(
    () =>
      AGENT_LANGUAGE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: `${opt.flag}  ${opt.value === 'system' ? '跟随系统' : opt.label}`,
        meta: { flag: opt.flag },
      })),
    []
  );

  const renderLanguageOption = useCallback(
    (
      option: { value: string; label: string; meta?: Record<string, unknown> },
      isSelected: boolean
    ) => (
      <>
        <Check className={`mr-2 size-3.5 shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
        <span className="text-[var(--color-text)]">{option.label}</span>
      </>
    ),
    []
  );

  const saveRateLimit = useCallback(async () => {
    try {
      await api.ccSettings.patch({
        rate_limit_max_messages: ccSettings.rate_limit_max_messages,
        rate_limit_window_secs: ccSettings.rate_limit_window_secs,
      } as Record<string, unknown>);
    } catch {
      // silent
    }
  }, [ccSettings.rate_limit_max_messages, ccSettings.rate_limit_window_secs]);

  return (
    <div className="space-y-5">
      {/* Language */}
      <SettingsSectionCard
        title="Agent 语言"
        description="控制数字员工与用户交流时默认使用的语言。"
        icon={<Bot className="size-3.5" />}
      >
        <SettingRow label="语言" description={agentLanguageDescription}>
          <Combobox
            options={languageComboboxOptions}
            value={safeConfig.general.agentLanguage ?? 'system'}
            onValueChange={onLanguageChange}
            placeholder="选择语言..."
            searchPlaceholder="搜索语言..."
            emptyMessage="未找到匹配语言。"
            disabled={saving}
            className="min-w-[180px]"
            renderOption={renderLanguageOption}
          />
        </SettingRow>
      </SettingsSectionCard>

      {/* Appearance */}
      <SettingsSectionCard
        title="外观"
        description="调整主题、展开行为和界面默认显示方式。"
        icon={<Palette className="size-3.5" />}
      >
        <SettingRow label="主题" description="选择你偏好的界面主题">
          <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={saving}
                className={cn(
                  'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                  safeConfig.general.theme === opt.value
                    ? 'shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                )}
                style={
                  safeConfig.general.theme === opt.value
                    ? {
                        backgroundColor: 'var(--color-accent-muted)',
                        color: 'var(--color-accent)',
                      }
                    : undefined
                }
                onClick={() => onThemeChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          label="默认展开 AI 回复"
          description="打开会话记录或收到新消息时，自动展开每轮回复"
        >
          <SettingsToggle
            enabled={safeConfig.general.autoExpandAIGroups ?? false}
            onChange={(v) => onGeneralToggle('autoExpandAIGroups', v)}
            disabled={saving}
          />
        </SettingRow>
      </SettingsSectionCard>

      {/* Server Status */}
      <SettingsSectionCard
        title="服务状态"
        description="查看诊断服务连接和本地服务地址。"
        icon={<Server className="size-3.5" />}
      >
        <div
          className="m-3 flex items-center gap-3 rounded-xl border px-3 py-2.5"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border-subtle)',
          }}
        >
          <div
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: serverStatus.running ? '#22c55e' : '#f59e0b' }}
          />
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {serverStatus.running ? 'Web 服务运行中' : 'Web 服务状态未知'}
          </span>
          <code
            className="rounded px-1.5 py-0.5 font-mono text-xs"
            style={{
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          >
            {serverLoading ? '检查中...' : serverUrl}
          </code>
          <button
            onClick={handleCopyUrl}
            className="ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/5"
            style={{
              borderColor: 'var(--color-border)',
              color: copied ? '#22c55e' : 'var(--color-text-secondary)',
            }}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? '已复制' : '复制链接'}
          </button>
        </div>
        {serverError && (
          <p className="px-3 pb-2 text-xs text-red-400">服务状态获取失败：{serverError}</p>
        )}
        <p className="px-3 pb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          当前为 Web 诊断模式。服务由 AgentCLI 后端托管，不能在浏览器内启动或关闭。
        </p>
      </SettingsSectionCard>

      {/* Runtime Settings */}
      <SettingsSectionCard
        title="运行设置"
        description="控制 Claude Code 运行时输出、限流和会话超时策略。"
        icon={<Gauge className="size-3.5" />}
      >
        {ccSettingsLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="size-3.5 animate-spin" />
            正在加载...
          </div>
        ) : (
          <>
            <SettingRow label="附件回传" description="控制是否将对话中的附件文件回传给 Agent">
              <SettingsSelect
                value={ccSettings.attachment_send}
                options={CC_ATTACHMENT_OPTIONS}
                onChange={(v) => void autoSaveCcSetting('attachment_send', v)}
              />
            </SettingRow>
            <SettingRow label="空闲超时" description="Agent 空闲多久后自动断开（分钟）">
              <CompactNum
                value={ccSettings.idle_timeout_mins}
                onChange={(v) => patchCcSettings({ idle_timeout_mins: v })}
                onSave={() =>
                  void autoSaveCcSetting('idle_timeout_mins', ccSettings.idle_timeout_mins)
                }
                min={0}
              />
            </SettingRow>
            <SettingRow label="日志等级" description="运行时日志输出级别">
              <SettingsSelect
                value={ccSettings.log_level}
                options={CC_LOG_LEVEL_OPTIONS}
                onChange={(v) => void autoSaveCcSetting('log_level', v)}
              />
            </SettingRow>
            <SettingRow label="显示 Thinking 消息" description="在对话中展示 Agent 的思考过程">
              <SettingsToggle
                enabled={ccSettings.thinking_messages}
                onChange={(v) => void autoSaveCcSetting('thinking_messages', v)}
              />
            </SettingRow>
            <SettingRow label="显示工具进度" description="在对话中展示 Agent 调用工具的详细信息">
              <SettingsToggle
                enabled={ccSettings.tool_messages}
                onChange={(v) => void autoSaveCcSetting('tool_messages', v)}
              />
            </SettingRow>
            <SettingRow label="启用流式预览" description="实时预览 Agent 的流式输出内容">
              <SettingsToggle
                enabled={ccSettings.stream_preview_enabled}
                onChange={(v) => void autoSaveCcSetting('stream_preview_enabled', v)}
              />
            </SettingRow>
            <SettingRow label="Thinking 最大长度" description="截断展示的 Thinking 消息最大字符数">
              <CompactNum
                value={ccSettings.thinking_max_len}
                onChange={(v) => patchCcSettings({ thinking_max_len: v })}
                onSave={() =>
                  void autoSaveCcSetting('thinking_max_len', ccSettings.thinking_max_len)
                }
                min={0}
              />
            </SettingRow>
            <SettingRow label="工具消息最大长度" description="截断展示的工具消息最大字符数">
              <CompactNum
                value={ccSettings.tool_max_len}
                onChange={(v) => patchCcSettings({ tool_max_len: v })}
                onSave={() => void autoSaveCcSetting('tool_max_len', ccSettings.tool_max_len)}
                min={0}
              />
            </SettingRow>
            <SettingRow label="预览间隔" description="流式预览刷新间隔（毫秒）">
              <CompactNum
                value={ccSettings.stream_preview_interval_ms}
                onChange={(v) => patchCcSettings({ stream_preview_interval_ms: v })}
                onSave={() =>
                  void autoSaveCcSetting(
                    'stream_preview_interval_ms',
                    ccSettings.stream_preview_interval_ms
                  )
                }
                min={100}
              />
            </SettingRow>
            <SettingRow label="频率限制" description="限制时间窗口内发送的最大消息数">
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <CompactNum
                  value={ccSettings.rate_limit_max_messages}
                  onChange={(v) => patchCcSettings({ rate_limit_max_messages: v })}
                  onSave={() => void saveRateLimit()}
                  min={0}
                  className="w-20"
                />
                <span>条 /</span>
                <CompactNum
                  value={ccSettings.rate_limit_window_secs}
                  onChange={(v) => patchCcSettings({ rate_limit_window_secs: v })}
                  onSave={() => void saveRateLimit()}
                  min={1}
                  className="w-20"
                />
                <span>秒</span>
              </div>
            </SettingRow>
          </>
        )}
      </SettingsSectionCard>

      {/* Privacy */}
      {import.meta.env.VITE_SENTRY_DSN && (
        <SettingsSectionCard
          title="隐私"
          description="配置匿名崩溃与性能数据上报。"
          icon={<Shield className="size-3.5" />}
        >
          <SettingRow label="发送崩溃报告" description="发送匿名崩溃与性能数据，帮助改进应用">
            <SettingsToggle
              enabled={safeConfig.general.telemetryEnabled ?? true}
              onChange={(v) => onGeneralToggle('telemetryEnabled', v)}
              disabled={saving}
            />
          </SettingRow>
        </SettingsSectionCard>
      )}
    </div>
  );
};

/**
 * GeneralSection - General settings including startup, appearance, browser access, and local Claude root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { Combobox } from '@renderer/components/ui/combobox';
import { cn } from '@renderer/lib/utils';
import { AGENT_LANGUAGE_OPTIONS, resolveLanguageName } from '@shared/utils/agentLanguage';
import { Bot, Check, Copy, Palette, Server } from 'lucide-react';

import { SettingRow, SettingsSectionCard, SettingsToggle } from '../components';

import type { SafeConfig } from '../hooks/useSettingsConfig';
import type { HttpServerStatus } from '@shared/types/api';
import type { AppConfig } from '@shared/types/notifications';

const THEME_OPTIONS = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
] as const;

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
  const [serverError, setServerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.httpServer
      .getStatus()
      .then(setServerStatus)
      .catch((error: unknown) => {
        setServerError(error instanceof Error ? error.message : '获取服务端状态失败');
      });
  }, []);

  const serverUrl = `${window.location.protocol}//${window.location.hostname}:${serverStatus.port}`;

  const handleCopyUrl = useCallback(() => {
    void navigator.clipboard.writeText(serverUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [serverUrl]);

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
            {serverUrl}
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
          当前为 Web 诊断模式。服务由 AgentPanel 后端托管，不能在浏览器内启动或关闭。
        </p>
      </SettingsSectionCard>
    </div>
  );
};

import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Check, ChevronRight, Github, Loader2, PlugZap } from 'lucide-react';

import { SettingsSectionCard } from '../components';

type ChannelState = 'disabled' | 'restart-required' | 'starting' | 'running' | 'offline';

function channelStatusLabel(state: ChannelState): string {
  switch (state) {
    case 'running':
      return '运行中';
    case 'starting':
      return '启动中';
    case 'restart-required':
      return '等待重启';
    case 'offline':
      return '未就绪';
    default:
      return '未启用';
  }
}

export const PluginsSection = ({
  onOpenExternalChannels,
}: Readonly<{
  onOpenExternalChannels: () => void;
}>): React.JSX.Element => {
  const [channelState, setChannelState] = useState<ChannelState>('disabled');
  const [githubBindingCount, setGithubBindingCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.externalChannels.get(), api.githubDelivery.listBindings()])
      .then(([channels, bindings]) => {
        if (cancelled) return;
        setChannelState(channels.ccConnect.state);
        setGithubBindingCount(bindings.length);
      })
      .catch(() => {
        if (!cancelled) setError('暂时无法读取插件状态；请稍后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5" data-testid="plugins-section">
      <div className="rounded-lg border border-[var(--color-accent-border)] bg-[var(--color-accent-soft)] px-3 py-2.5 text-xs leading-5 text-[var(--color-text-secondary)]">
        两个插件均已随 AgentPanel 内置，无需下载安装包。按需启用或绑定后才会参与工作流。
      </div>

      <SettingsSectionCard
        title="外部渠道 · cc-connect"
        description="将飞书、微信等外部消息渠道接入本地 Agent；默认不启动，不影响本地 Direct CLI。"
        icon={<PlugZap className="size-3.5" />}
      >
        <div className="flex flex-wrap items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text)]">
              <Check className="size-3.5 text-emerald-500" />
              已内置
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              当前状态：{channelStatusLabel(channelState)}
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenExternalChannels}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            管理渠道 <ChevronRight className="size-3.5" />
          </button>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        title="GitHub 成果交付"
        description="为智能体绑定 GitHub 仓库，将已批准的本地成果按版本推送到指定分支。"
        icon={<Github className="size-3.5" />}
      >
        <div className="p-3">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text)]">
            <Check className="size-3.5 text-emerald-500" />
            已内置
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {githubBindingCount === null ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" />
                正在读取绑定状态…
              </span>
            ) : githubBindingCount > 0 ? (
              `已有 ${githubBindingCount} 个智能体绑定仓库。`
            ) : (
              '尚未绑定仓库。任务审批后，在成果卡右上角点击“绑定仓库”即可设置。'
            )}
          </p>
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
            使用本机 Git Credential Manager 或 SSH Key；AgentPanel 不保存 GitHub
            Token、密码或私钥。本地成果目录与 ZIP 始终可用。
          </p>
        </div>
      </SettingsSectionCard>

      {error ? (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-300">
          {error}
        </p>
      ) : null}
    </div>
  );
};

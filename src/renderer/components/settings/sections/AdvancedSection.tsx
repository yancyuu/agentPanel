import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Textarea } from '@renderer/components/ui/textarea';
import appIcon from '@renderer/favicon.png';
import { emitOpenHermitEvent, OPEN_HERMIT_EVENTS } from '@renderer/utils/openHermitEvents';
import { PRODUCT_NAME } from '@shared/constants';
import { Check, FileEdit, Info, Loader2, PlugZap, RotateCcw, ServerCog, X } from 'lucide-react';

import { SettingsSectionCard } from '../components';

interface CcConnectConfigRawDialogProps {
  open: boolean;
  onClose: () => void;
}

const CcConnectConfigRawDialog = ({
  open,
  onClose,
}: CcConnectConfigRawDialogProps): React.JSX.Element | null => {
  const [filePath, setFilePath] = useState('~/.hermit/config.toml');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    api.ccConfig
      .getRaw()
      .then((data) => {
        if (cancelled) return;
        setFilePath(data.path);
        setContent(data.content);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '读取配置文件失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.ccConfig.updateRaw(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [content]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>编辑配置</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-text-muted)]">配置文件：{filePath}</p>
          {loading ? (
            <div className="flex min-h-[420px] items-center justify-center rounded-md border border-[var(--color-border)]">
              <Loader2 className="size-5 animate-spin text-[var(--color-text-muted)]" />
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[420px] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
          )}
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <X className="size-3.5" />
              {error}
            </div>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">
            保存后将直接覆盖 {PRODUCT_NAME} 管理的配置文件。若修改了端口或
            token，请点击”重启服务”生效。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            关闭
          </Button>
          <Button
            className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            onClick={() => void handleSave()}
            disabled={loading || saving}
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {saved && !saving ? <Check className="mr-1.5 size-3.5 text-emerald-400" /> : null}
            {saved && !saving ? '已保存' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface AdvancedSectionProps {
  readonly saving: boolean;
  readonly onResetToDefaults: () => void;
  readonly onExportConfig: () => void;
  readonly onImportConfig: () => void;
  readonly onOpenInEditor: () => void;
}

export const AdvancedSection = (_props: AdvancedSectionProps): React.JSX.Element => {
  const [version, setVersion] = useState<string>(__APP_VERSION__);
  const [ccConfigOpen, setCcConfigOpen] = useState(false);
  const [ccConnectEnabled, setCcConnectEnabled] = useState(false);
  const [channelRestartRequired, setChannelRestartRequired] = useState(false);
  const [channelState, setChannelState] = useState<
    'disabled' | 'restart-required' | 'starting' | 'running' | 'offline'
  >('disabled');
  const [channelLoading, setChannelLoading] = useState(true);
  const [channelSaving, setChannelSaving] = useState(false);
  const [channelMessage, setChannelMessage] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAppVersion()
      .then((nextVersion) => {
        if (typeof nextVersion === 'string' && nextVersion.trim()) {
          setVersion(nextVersion);
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.externalChannels
      .get()
      .then((status) => {
        if (!cancelled) {
          setCcConnectEnabled(status.ccConnect.enabled);
          setChannelRestartRequired(status.ccConnect.restartRequired);
          setChannelState(status.ccConnect.state);
        }
      })
      .catch(() => {
        if (!cancelled) setChannelMessage('无法读取外部渠道状态');
      })
      .finally(() => {
        if (!cancelled) setChannelLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChannelToggle = useCallback(async () => {
    setChannelSaving(true);
    setChannelMessage(null);
    try {
      const status = await api.externalChannels.setCcConnectEnabled(!ccConnectEnabled);
      setCcConnectEnabled(status.ccConnect.enabled);
      setChannelRestartRequired(status.ccConnect.restartRequired);
      setChannelState(status.ccConnect.state);
      setChannelMessage(
        status.ccConnect.restartRequired
          ? status.ccConnect.enabled
            ? '外部渠道已启用。请重启应用以准备并启动 cc-connect。'
            : '外部渠道已关闭。请重启应用以停止加载 cc-connect。'
          : status.ccConnect.active
            ? 'cc-connect 外部渠道正在运行。'
            : '外部渠道设置已保存。'
      );
    } catch (error) {
      setChannelMessage(error instanceof Error ? error.message : '保存外部渠道设置失败');
    } finally {
      setChannelSaving(false);
    }
  }, [ccConnectEnabled]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    setRestartMsg(null);
    try {
      if (channelRestartRequired) {
        setRestartMsg('正在重新启动应用…');
        await api.windowControls.relaunch();
        return;
      }
      await api.ccSettings.restart();
      emitOpenHermitEvent(OPEN_HERMIT_EVENTS.runtimeRestarted);
      setRestartMsg('已重启');
    } catch {
      setRestartMsg('重启失败');
    } finally {
      setRestarting(false);
      setTimeout(() => setRestartMsg(null), 3000);
    }
  }, [channelRestartRequired]);

  return (
    <div className="space-y-5">
      <SettingsSectionCard
        title="外部渠道"
        description="cc-connect 仅用于飞书、微信等外部消息渠道；关闭时本地 Agent 运行不受影响。"
        icon={<PlugZap className="size-3.5" />}
      >
        <div className="flex flex-wrap items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              启用 cc-connect 外部渠道
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {channelRestartRequired
                ? '设置已更改，需要重启应用后生效。'
                : channelState === 'running'
                  ? '正在运行，可接收外部消息渠道。'
                  : channelState === 'offline'
                    ? '已启用，但 cc-connect 当前未就绪。'
                    : '默认关闭：仅运行本地 Direct CLI。'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={ccConnectEnabled}
            disabled={channelLoading || channelSaving}
            onClick={() => void handleChannelToggle()}
            className="relative h-7 w-12 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              backgroundColor: ccConnectEnabled ? 'var(--color-accent)' : 'var(--color-border)',
            }}
          >
            <span
              className="absolute top-1 size-5 rounded-full bg-white shadow-sm transition-transform"
              style={{ transform: ccConnectEnabled ? 'translateX(25px)' : 'translateX(4px)' }}
            />
          </button>
        </div>
        {channelMessage ? (
          <p className="px-3 pb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {channelMessage}
          </p>
        ) : null}
        {channelRestartRequired ? (
          <div className="px-3 pb-3">
            <button
              type="button"
              onClick={() => void handleRestart()}
              disabled={restarting}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {restarting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              重启应用并应用设置
            </button>
          </div>
        ) : null}
      </SettingsSectionCard>

      {ccConnectEnabled && !channelRestartRequired ? (
        <SettingsSectionCard
          title="服务配置"
          description={`编辑 ${PRODUCT_NAME} 运行配置，或在配置变更后重启本地服务。`}
          icon={<ServerCog className="size-3.5" />}
        >
          <div className="flex flex-wrap gap-2 p-3">
            <button
              onClick={() => setCcConfigOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-150 hover:bg-[var(--color-accent-soft)]"
              style={{
                borderColor: 'var(--color-accent-border)',
                color: 'var(--color-accent)',
              }}
            >
              <FileEdit className="size-3.5" />
              编辑配置
            </button>
            <button
              onClick={() => void handleRestart()}
              disabled={restarting}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-150 hover:bg-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {restarting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              重启服务
            </button>
          </div>
          {restartMsg && (
            <p
              className="px-3 pb-3 text-xs"
              style={{ color: restartMsg.includes('失败') ? '#f87171' : 'var(--color-accent)' }}
            >
              {restartMsg}
            </p>
          )}
        </SettingsSectionCard>
      ) : null}

      <SettingsSectionCard
        title="关于"
        description="当前应用版本和产品信息。"
        icon={<Info className="size-3.5" />}
      >
        <div className="flex items-start gap-4 p-3">
          <img src={appIcon} alt="应用图标" className="size-10 rounded-lg" />
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {PRODUCT_NAME}
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Version {version || '...'}
            </p>
            <p
              className="mt-2 text-xs leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              本地优先的 AI Agent 团队工作台。支持多模型供应商接入、自主任务管理和跨团队协作。
            </p>
          </div>
        </div>
      </SettingsSectionCard>

      {ccConnectEnabled ? (
        <CcConnectConfigRawDialog open={ccConfigOpen} onClose={() => setCcConfigOpen(false)} />
      ) : null}
    </div>
  );
};

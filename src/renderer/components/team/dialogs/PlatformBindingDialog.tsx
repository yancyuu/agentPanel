import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import assistantCreationOptions from '@shared/assistantCreationOptions.json';
import { Settings2, Smartphone } from 'lucide-react';

import PlatformManualForm from './PlatformManualForm';
import { isQRPlatform, platformMeta } from './platformMeta';
import PlatformSetupQR from './PlatformSetupQR';

interface PlatformOption {
  key: string;
  label: string;
  color: string;
  icon: 'qr' | 'settings';
}

const PLATFORM_COLORS: Record<string, string> = {
  feishu: 'bg-blue-50 dark:bg-blue-900/30 text-indigo-600 dark:text-indigo-400',
  weixin: 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  telegram: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400',
  discord: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400',
  slack: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
  dingtalk: 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  wecom_im: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
  qq: 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400',
  qqbot: 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400',
  line: 'bg-lime-50 dark:bg-lime-900/30 text-lime-600 dark:text-lime-400',
  weibo: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400',
};

const PLATFORM_OPTIONS: PlatformOption[] = assistantCreationOptions.platformOptions.map(
  (option) => ({
    key: option.key,
    label: option.label,
    color:
      PLATFORM_COLORS[option.key] ??
      'bg-gray-50 dark:bg-gray-900/30 text-gray-600 dark:text-gray-400',
    icon: option.icon as PlatformOption['icon'],
  })
);

const WECOM_IM_PLATFORM_KEY = 'wecom_im';

const WECOM_MODE_OPTIONS = assistantCreationOptions.wecomModeOptions;

type WeComModeKey = (typeof WECOM_MODE_OPTIONS)[number]['key'];

const isWeComModeKey = (key: string): key is WeComModeKey => key === 'wecom_ws' || key === 'wecom';

type BindingStep = 'platform' | 'wecom-mode' | 'qr' | 'form';

export interface PlatformBindingCompleteOptions {
  restartHandled?: boolean;
}

interface PlatformBindingContentProps {
  projectName: string;
  workDir: string;
  agentType: string;
  platformAllowFrom?: Record<string, string>;
  platformAllowChat?: Record<string, string>;
  onComplete: (options?: PlatformBindingCompleteOptions) => void;
  onCancel: () => void;
}

export const PlatformBindingContent = ({
  projectName,
  workDir,
  agentType,
  platformAllowFrom = {},
  platformAllowChat = {},
  onComplete,
  onCancel,
}: PlatformBindingContentProps): React.JSX.Element => {
  const [step, setStep] = useState<BindingStep>('platform');
  const [selectedPlatform, setSelectedPlatform] = useState('');

  useEffect(() => {
    setStep('platform');
    setSelectedPlatform('');
  }, [projectName, workDir, agentType]);

  const handlePlatformSelect = (key: string): void => {
    if (key === WECOM_IM_PLATFORM_KEY) {
      setSelectedPlatform('');
      setStep('wecom-mode');
      return;
    }

    setSelectedPlatform(key);
    setStep(isQRPlatform(key) ? 'qr' : 'form');
  };

  const handleWeComModeSelect = (key: WeComModeKey): void => {
    setSelectedPlatform(key);
    setStep('form');
  };

  const initialFormValues = useMemo((): Record<string, unknown> => {
    const meta = platformMeta[selectedPlatform];
    const values: Record<string, unknown> = {};
    const allowFrom =
      selectedPlatform === 'lark'
        ? (platformAllowFrom.lark ?? platformAllowFrom.feishu)
        : platformAllowFrom[selectedPlatform];
    const allowChat =
      selectedPlatform === 'lark'
        ? (platformAllowChat.lark ?? platformAllowChat.feishu)
        : platformAllowChat[selectedPlatform];
    if (allowFrom && meta?.fields.some((field) => field.key === 'allow_from')) {
      values.allow_from = allowFrom;
    }
    if (allowChat && meta?.fields.some((field) => field.key === 'allow_chat')) {
      values.allow_chat = allowChat;
    }
    return values;
  }, [platformAllowChat, platformAllowFrom, selectedPlatform]);

  if (step === 'wecom-mode') {
    return (
      <div className="space-y-3 py-2">
        <div className="bg-[var(--color-surface-raised)]/60 relative overflow-hidden rounded-xl border border-[var(--color-border-subtle)] px-3 py-2.5 text-xs text-[var(--color-text-muted)] shadow-sm shadow-black/10">
          <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent" />
          <p>选择企业微信接入方式。不同模式需要的参数不同，配置会复用 cc-connect 的现有协议。</p>
        </div>
        <div className="grid gap-2">
          {WECOM_MODE_OPTIONS.map(({ key, label, description }) => (
            <button
              key={key}
              type="button"
              onClick={() => handleWeComModeSelect(key)}
              className="group rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-left shadow-sm shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent-border)] hover:bg-[var(--color-accent-soft)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
            >
              <div className="text-sm font-medium text-[var(--color-text)]">{label}</div>
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{description}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-start pt-2">
          <Button variant="outline" size="sm" onClick={() => setStep('platform')}>
            返回
          </Button>
        </div>
      </div>
    );
  }

  if (
    step === 'qr' &&
    (selectedPlatform === 'feishu' || selectedPlatform === 'lark' || selectedPlatform === 'weixin')
  ) {
    return (
      <PlatformSetupQR
        platformType={selectedPlatform}
        projectName={projectName}
        workDir={workDir}
        agentType={agentType}
        onComplete={onComplete}
        onCancel={() => setStep('platform')}
      />
    );
  }

  if (step === 'form' && platformMeta[selectedPlatform]) {
    return (
      <PlatformManualForm
        platformType={selectedPlatform}
        platformMeta={platformMeta[selectedPlatform]}
        projectName={projectName}
        workDir={workDir}
        agentType={agentType}
        initialValues={initialFormValues}
        onComplete={onComplete}
        onCancel={() => setStep(isWeComModeKey(selectedPlatform) ? 'wecom-mode' : 'platform')}
      />
    );
  }

  return (
    <div className="space-y-3 py-2">
      <div className="bg-[var(--color-surface-raised)]/60 relative overflow-hidden rounded-xl border border-[var(--color-border-subtle)] px-3 py-2.5 text-xs text-[var(--color-text-muted)] shadow-sm shadow-black/10">
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent" />
        <p>
          绑定渠道是可选项，用于将数字员工暴露到飞书、微信等外部平台；不绑定也可以在本机直接运行。
        </p>
      </div>
      <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
        {PLATFORM_OPTIONS.map(({ key, label, color, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => handlePlatformSelect(key)}
            className="group flex items-center gap-2.5 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-left shadow-sm shadow-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent-border)] hover:bg-[var(--color-accent-soft)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          >
            <div className={`size-9 rounded-lg ${color} flex shrink-0 items-center justify-center`}>
              {icon === 'qr' ? <Smartphone size={16} /> : <Settings2 size={16} />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--color-text)]">{label}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {icon === 'qr' ? '扫码绑定' : '手动配置'}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="flex justify-start pt-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
};

interface PlatformBindingDialogProps extends PlatformBindingContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const PlatformBindingDialog = ({
  open,
  onOpenChange,
  projectName,
  workDir,
  agentType,
  platformAllowFrom,
  platformAllowChat,
  onComplete,
  onCancel,
}: PlatformBindingDialogProps): React.JSX.Element => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl sm:w-[40rem]">
        <DialogHeader>
          <DialogTitle className="text-sm">绑定渠道</DialogTitle>
          <DialogDescription className="text-xs">
            可选：为当前数字员工选择外部平台渠道，绑定后通过 AgentCLI 对外接收 Loop 指令。
          </DialogDescription>
        </DialogHeader>
        <PlatformBindingContent
          key={`${projectName}:${workDir}:${agentType}:${open ? 'open' : 'closed'}`}
          projectName={projectName}
          workDir={workDir}
          agentType={agentType}
          platformAllowFrom={platformAllowFrom}
          platformAllowChat={platformAllowChat}
          onComplete={onComplete}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  );
};

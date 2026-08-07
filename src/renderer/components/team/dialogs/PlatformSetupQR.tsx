import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Smartphone, XCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

type PlatformKind = 'feishu' | 'lark' | 'weixin';
type Phase =
  | 'idle'
  | 'loading'
  | 'scanning'
  | 'scanned'
  | 'completed'
  | 'expired'
  | 'denied'
  | 'error'
  | 'saving'
  | 'restarting';

interface Props {
  platformType: PlatformKind;
  projectName: string;
  workDir: string;
  agentType: string;
  onComplete: (options?: { restartHandled?: boolean }) => void;
  onCancel: () => void;
}

const PlatformSetupQR = ({
  platformType,
  projectName,
  workDir,
  agentType,
  onComplete,
  onCancel,
}: Readonly<Props>): React.JSX.Element => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [error, setError] = useState('');
  const [restartHandled, setRestartHandled] = useState(false);
  const cancelledRef = useRef(false);
  const pollingRef = useRef(false);
  const completingRef = useRef(false);

  const feishuRef = useRef({ deviceCode: '', baseUrl: '', interval: 5 });
  const weixinRef = useRef({ qrKey: '', apiUrl: '' });

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const isFeishu = platformType === 'feishu' || platformType === 'lark';

  const startFeishuFlow = useCallback(async () => {
    setPhase('loading');
    setError('');
    setRestartHandled(false);
    completingRef.current = false;
    cancelledRef.current = false;
    pollingRef.current = false;
    try {
      const res = await api.ccSetup.feishuBegin();
      feishuRef.current = {
        deviceCode: res.device_code,
        baseUrl: res.base_url ?? '',
        interval: res.interval || 5,
      };
      setQrUrl(res.qr_url);
      setPhase('scanning');
      pollFeishu();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  const pollFeishu = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;

    const poll = async () => {
      while (!cancelledRef.current) {
        try {
          const res = await api.ccSetup.feishuPoll(
            feishuRef.current.deviceCode,
            feishuRef.current.baseUrl || undefined
          );
          if (cancelledRef.current) break;
          if (res.base_url) feishuRef.current.baseUrl = res.base_url;
          if (res.slow_down) feishuRef.current.interval += 5;

          switch (res.status) {
            case 'completed': {
              setPhase('saving');
              const saved = await api.ccSetup.feishuSave({
                project: projectName,
                app_id: res.app_id!,
                app_secret: res.app_secret!,
                platform_type: res.platform,
                owner_open_id: res.owner_open_id,
                work_dir: workDir,
                agent_type: agentType,
              });
              setRestartHandled(saved.restart_handled === true);
              setPhase('completed');
              pollingRef.current = false;
              return;
            }
            case 'denied': {
              setPhase('denied');
              pollingRef.current = false;
              return;
            }
            case 'expired': {
              setPhase('expired');
              pollingRef.current = false;
              return;
            }
            case 'error': {
              setError(res.error || 'Unknown error');
              setPhase('error');
              pollingRef.current = false;
              return;
            }
          }
        } catch (e: unknown) {
          if (cancelledRef.current) break;
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
          pollingRef.current = false;
          return;
        }
        await sleep(feishuRef.current.interval * 1000);
      }
      pollingRef.current = false;
    };
    poll();
  }, [projectName, workDir, agentType]);

  const startWeixinFlow = useCallback(async () => {
    setPhase('loading');
    setError('');
    setRestartHandled(false);
    completingRef.current = false;
    cancelledRef.current = false;
    pollingRef.current = false;
    try {
      const res = await api.ccSetup.weixinBegin();
      if (!res.qr_url) {
        setError('微信未返回二维码 URL，请检查服务配置');
        setPhase('error');
        return;
      }
      weixinRef.current = {
        qrKey: res.qr_key,
        apiUrl: res.api_url ?? '',
      };
      setQrUrl(res.qr_url);
      setPhase('scanning');

      let consecutiveErrors = 0;
      while (!cancelledRef.current) {
        try {
          const pollRes = await api.ccSetup.weixinPoll(
            weixinRef.current.qrKey,
            weixinRef.current.apiUrl || undefined
          );
          consecutiveErrors = 0;
          if (cancelledRef.current) break;

          switch (pollRes.status) {
            case 'scaned': {
              setPhase('scanned');
              break;
            }
            case 'confirmed': {
              setPhase('saving');
              const saved = await api.ccSetup.weixinSave({
                project: projectName,
                token: pollRes.bot_token!,
                base_url: pollRes.base_url,
                ilink_bot_id: pollRes.ilink_bot_id,
                ilink_user_id: pollRes.ilink_user_id,
                work_dir: workDir,
                agent_type: agentType,
              });
              setRestartHandled(saved.restart_handled === true);
              setPhase('completed');
              return;
            }
            case 'expired': {
              setPhase('expired');
              return;
            }
          }
        } catch (e: unknown) {
          if (cancelledRef.current) break;
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('error');
            return;
          }
        }
        await sleep(500);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [projectName, workDir, agentType]);

  const startFlow = isFeishu ? startFeishuFlow : startWeixinFlow;

  const handleRetry = () => {
    cancelledRef.current = false;
    pollingRef.current = false;
    startFlow();
  };

  const handleComplete = (): void => {
    if (completingRef.current) return;
    completingRef.current = true;
    setError('');
    setPhase('restarting');
    onComplete({ restartHandled });
  };

  const platformLabel = isFeishu ? '飞书 / Lark' : '微信 (ilink)';
  const scanHint = isFeishu ? '打开飞书 / Lark App 扫描二维码' : '打开微信扫描二维码';

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      {phase === 'idle' && (
        <>
          <Smartphone size={48} className="text-gray-400 dark:text-gray-500" />
          <p className="text-center text-sm text-gray-600 dark:text-gray-400">
            使用手机扫描 {platformLabel} 二维码，快速绑定渠道
          </p>
          <Button
            className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            onClick={startFlow}
          >
            开始扫码绑定
          </Button>
        </>
      )}

      {phase === 'loading' && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 size={32} className="animate-spin text-indigo-500" />
          <p className="text-sm text-gray-500">正在生成二维码...</p>
        </div>
      )}

      {(phase === 'scanning' || phase === 'scanned' || phase === 'saving') && (
        <>
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <QRCodeSVG value={qrUrl} size={200} level="M" />
          </div>
          <p className="max-w-xs text-center text-sm text-gray-600 dark:text-gray-400">
            {phase === 'scanned'
              ? '已扫描！请在手机上确认...'
              : phase === 'saving'
                ? '正在保存配置...'
                : scanHint}
          </p>
          {phase === 'scanning' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" /> 等待扫描...
            </div>
          )}
          {phase === 'scanned' && (
            <div className="flex items-center gap-2 text-xs text-indigo-500">
              <Loader2 size={12} className="animate-spin" /> 等待确认...
            </div>
          )}
          {phase === 'saving' && (
            <div className="flex items-center gap-2 text-xs text-indigo-500">
              <Loader2 size={12} className="animate-spin" /> 正在保存配置...
            </div>
          )}
        </>
      )}

      {(phase === 'completed' || phase === 'restarting') && (
        <div className="flex flex-col items-center gap-3 py-4">
          {phase === 'restarting' ? (
            <Loader2 size={48} className="animate-spin text-indigo-500" />
          ) : (
            <CheckCircle2 size={48} className="text-green-500" />
          )}
          <p className="text-sm font-medium text-green-700 dark:text-green-400">平台绑定成功！</p>
          <p className="text-center text-xs text-gray-500">
            {restartHandled
              ? '服务已重启并刷新平台长连接。'
              : phase === 'restarting'
                ? '正在重启服务并刷新平台长连接...'
                : '下一步将统一重启服务并刷新平台长连接。'}
          </p>
          <div className="flex gap-2">
            <Button
              onClick={handleComplete}
              disabled={phase === 'restarting'}
              className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            >
              {phase === 'restarting' && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {phase === 'restarting' ? '正在重启...' : restartHandled ? '完成' : '重启并完成'}
            </Button>
          </div>
        </div>
      )}

      {phase === 'expired' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <XCircle size={48} className="text-amber-500" />
          <p className="text-sm text-amber-700 dark:text-amber-400">二维码已过期</p>
          <Button variant="outline" onClick={handleRetry}>
            <RefreshCw size={14} /> 重试
          </Button>
        </div>
      )}

      {phase === 'denied' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <XCircle size={48} className="text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-400">授权被拒绝</p>
          <Button variant="outline" onClick={handleRetry}>
            <RefreshCw size={14} /> 重试
          </Button>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <XCircle size={48} className="text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          <Button variant="outline" onClick={handleRetry}>
            <RefreshCw size={14} /> 重试
          </Button>
        </div>
      )}

      {phase !== 'completed' && (
        <button
          onClick={onCancel}
          className="mt-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          取消
        </button>
      )}
    </div>
  );
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default PlatformSetupQR;

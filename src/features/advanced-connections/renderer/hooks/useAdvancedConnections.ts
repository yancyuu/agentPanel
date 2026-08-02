import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import {
  type AdvancedConnectionSummary,
  type AdvancedConnectionTokenCatalogSummary,
  type DiscoverAdvancedConnectionResponse,
} from '../../contracts';

/** 一次面板操作的最近一次结果（时间 + 成功/失败 + 摘要文案） */
export interface AdvancedConnectionOperationOutcome {
  ok: boolean;
  at: string;
  text: string;
}

/** 把远程错误归纳为可读文案：区分授权失效 / 服务端 4xx / 服务端 5xx / 网络错误 */
export function describeConnectionOperationError(message: string): string {
  if (/401|未授权|授权已失效|请先完成用户授权/.test(message)) {
    return `授权已失效，请重新登录（${message}）`;
  }
  if (/HTTP 4\d\d/.test(message)) return `服务端拒绝请求（${message}）`;
  if (/HTTP 5\d\d/.test(message)) return `服务端异常（${message}）`;
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|超时|网络/i.test(message)) {
    return `网络错误（${message}）`;
  }
  return message;
}

function isAuthExpired(message: string): boolean {
  return /401|未授权|授权已失效|请先完成用户授权/.test(message);
}
import { advancedConnectionsApi } from '../adapters/advancedConnectionsApi';

const DEFAULT_AGENTBUS_HOST = 'https://agentbus.skg.com/';

// Return type is exported below via ReturnType so the hook stays in sync with its state/actions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- exported ReturnType below keeps the public contract synchronized
function useAdvancedConnectionsState() {
  const [connections, setConnections] = useState<AdvancedConnectionSummary[]>([]);
  const [host, setHost] = useState(DEFAULT_AGENTBUS_HOST);
  const [preview, setPreview] = useState<DiscoverAdvancedConnectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<
    Record<string, AdvancedConnectionOperationOutcome>
  >({});
  const [catalogs, setCatalogs] = useState<
    Record<string, AdvancedConnectionTokenCatalogSummary | undefined>
  >({});
  const [channelStatus, setChannelStatus] = useState<
    Record<string, AdvancedConnectionOperationOutcome>
  >({});

  const refresh = useCallback(async () => {
    try {
      const next = await advancedConnectionsApi.list();
      setConnections(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '读取高级连接失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const authenticating = useMemo(
    () => connections.some((connection) => connection.state === 'authenticating'),
    [connections]
  );

  useEffect(() => {
    if (!authenticating) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [authenticating, refresh]);

  const lastErrorRef = useRef<string>('操作失败');
  const lastFailure = (fallback: string): AdvancedConnectionOperationOutcome => {
    const message = describeConnectionOperationError(lastErrorRef.current || fallback);
    return { ok: false, at: new Date().toISOString(), text: message };
  };

  const run = useCallback(async <T>(key: string, action: () => Promise<T>): Promise<T | null> => {
    setBusyAction(key);
    setError(null);
    setNotice(null);
    try {
      return await action();
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : '操作失败';
      lastErrorRef.current = message;
      setError(describeConnectionOperationError(message));
      return null;
    } finally {
      setBusyAction(null);
    }
  }, []);

  // 授权失效时联动刷新连接状态
  const refreshIfAuthExpired = useCallback(async () => {
    if (isAuthExpired(lastErrorRef.current)) await refresh();
  }, [refresh]);

  const discover = useCallback(async () => {
    const result = await run('discover', () => advancedConnectionsApi.discover({ baseUrl: host }));
    if (result) setPreview(result);
  }, [host, run]);

  const addConnection = useCallback(async () => {
    if (!preview) return;
    const result = await run('create', () =>
      advancedConnectionsApi.create({ baseUrl: preview.baseUrl })
    );
    if (!result) return;
    setHost(DEFAULT_AGENTBUS_HOST);
    setPreview(null);
    setNotice('连接服务已添加，下一步请完成用户授权。');
    await refresh();
  }, [preview, refresh, run]);

  const removeConnection = useCallback(
    async (connectionId: string) => {
      const result = await run(`remove:${connectionId}`, () =>
        advancedConnectionsApi.remove(connectionId)
      );
      if (result) await refresh();
    },
    [refresh, run]
  );

  const startAuth = useCallback(
    async (connection: AdvancedConnectionSummary) => {
      const method = connection.authMethods.find((item) => item.type === 'device_code');
      if (!method) {
        setError('服务没有声明当前客户端支持的授权方式');
        return;
      }
      const result = await run(`auth:${connection.id}`, () =>
        advancedConnectionsApi.startAuth(connection.id, method.id)
      );
      if (!result) return;
      const opened = await api.openExternal(result.authorizationUrl);
      if (!opened.success) {
        setError(opened.error || '无法打开授权页面');
        return;
      }
      setNotice(
        result.userCode
          ? `授权页面已打开，请输入验证码 ${result.userCode} 完成登录。`
          : '授权页面已打开，请在浏览器中完成公司账号登录。'
      );
      await refresh();
    },
    [refresh, run]
  );

  const logout = useCallback(
    async (connectionId: string) => {
      const result = await run(`logout:${connectionId}`, () =>
        advancedConnectionsApi.logout(connectionId)
      );
      if (result) await refresh();
    },
    [refresh, run]
  );

  const allowInsecure = useCallback(
    async (connectionId: string) => {
      const result = await run(`insecure-allow:${connectionId}`, () =>
        advancedConnectionsApi.allowInsecure(connectionId)
      );
      if (result) {
        setConnections((current) =>
          current.map((connection) => (connection.id === result.id ? result : connection))
        );
      }
    },
    [run]
  );

  const syncConnection = useCallback(
    async (connectionId: string) => {
      const result = await run(`sync:${connectionId}`, () =>
        advancedConnectionsApi.sync(connectionId)
      );
      if (!result) {
        setChannelStatus((current) => ({ ...current, [connectionId]: lastFailure('同步失败') }));
        await refreshIfAuthExpired();
        return;
      }
      setChannelStatus((current) => ({
        ...current,
        [connectionId]: {
          ok: true,
          at: new Date().toISOString(),
          text: result.sent.length
            ? `已同步 ${result.sent.length} 个数据通道：${result.sent.map((item) => item.channel).join('、')}。`
            : result.skipped
                .map((item) => item.reason)
                .filter(Boolean)
                .join('；') || '没有需要同步的数据。',
        },
      }));
      await refresh();
    },
    [refresh, refreshIfAuthExpired, run]
  );

  const pullRemoteTasks = useCallback(
    async (connectionId: string) => {
      const result = await run(`pull:${connectionId}`, () =>
        advancedConnectionsApi.pullTasks(connectionId)
      );
      if (!result) {
        setChannelStatus((current) => ({
          ...current,
          [connectionId]: lastFailure('检查远程任务失败'),
        }));
        await refreshIfAuthExpired();
        return;
      }
      const titles = result.tasks
        .slice(0, 3)
        .map((task) => task.title)
        .join('、');
      setChannelStatus((current) => ({
        ...current,
        [connectionId]: {
          ok: true,
          at: new Date().toISOString(),
          text: result.tasks.length
            ? `发现 ${result.tasks.length} 个远程任务${titles ? `：${titles}${result.tasks.length > 3 ? ' 等' : ''}` : ''}。为安全起见，尚未自动执行。`
            : '远端暂无分配任务。',
        },
      }));
    },
    [refreshIfAuthExpired, run]
  );

  const checkTokenCatalog = useCallback(
    async (connectionId: string) => {
      const result = await run(`catalog:${connectionId}`, () =>
        advancedConnectionsApi.tokenCatalog(connectionId)
      );
      if (!result) return;
      setCatalogs((current) => ({
        ...current,
        [connectionId]: result.ok ? result.catalog : undefined,
      }));
      setCatalogStatus((current) => ({
        ...current,
        [connectionId]: {
          ok: result.ok,
          at: new Date().toISOString(),
          text: result.ok
            ? result.available
              ? `Token 池连接正常，可用模型 ${result.catalog?.modelCount ?? 0} 个${result.catalog?.defaultModelName ? `，默认模型 ${result.catalog.defaultModelName}` : ''}。`
              : '该服务未提供 Token 池。'
            : describeConnectionOperationError(result.error || 'Token 池暂不可用。'),
        },
      }));
      if (!result.ok) return;
    },
    [run]
  );

  const claimAndApplyToken = useCallback(
    async (connectionId: string) => {
      const catalog = catalogs[connectionId];
      if (!catalog?.discoveryId) {
        setError('请先检测 Token 池并读取最新目录');
        return;
      }
      const modelApiIds =
        catalog.defaultModelApiIds.length > 0
          ? catalog.defaultModelApiIds
          : catalog.models.map((model) => model.id);
      const result = await run(`claim:${connectionId}`, () =>
        advancedConnectionsApi.claimAndApplyToken(connectionId, {
          discoveryId: catalog.discoveryId!,
          regionId: catalog.regionId,
          gatewayId: catalog.gatewayId,
          modelApiIds,
          runtimes: ['claude', 'codex', 'pi'],
        })
      );
      if (!result) {
        setCatalogStatus((current) => ({
          ...current,
          [connectionId]: lastFailure('领取 Token 失败'),
        }));
        await refreshIfAuthExpired();
        return;
      }
      const applied = result.runtimes
        .filter((runtime) => runtime.ok)
        .map((runtime) => runtime.runtime)
        .join('、');
      setCatalogStatus((current) => ({
        ...current,
        [connectionId]: {
          ok: true,
          at: new Date().toISOString(),
          text: result.warnings.length
            ? `Token ${result.maskedKey} 已应用到 ${applied || '部分运行时'}；${result.warnings.join('；')}`
            : `Token ${result.maskedKey} 已安全领取并应用到 ${applied}。`,
        },
      }));
    },
    [catalogs, refreshIfAuthExpired, run]
  );

  return {
    connections,
    host,
    setHost: (value: string) => {
      setHost(value);
      setPreview(null);
    },
    preview,
    loading,
    busyAction,
    error,
    notice,
    catalogStatus,
    catalogs,
    channelStatus,
    discover,
    addConnection,
    removeConnection,
    startAuth,
    logout,
    allowInsecure,
    syncConnection,
    pullRemoteTasks,
    checkTokenCatalog,
    claimAndApplyToken,
    refresh,
  };
}

export type UseAdvancedConnectionsResult = ReturnType<typeof useAdvancedConnectionsState>;

export function useAdvancedConnections(): UseAdvancedConnectionsResult {
  return useAdvancedConnectionsState();
}

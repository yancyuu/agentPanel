/**
 * 用量上报设置的读写（settings.json taskBus.telemetry.enabled）。
 * PUT 走既有 taskBusSettingsRoutes：保存后按 enabled 自动 startTelemetry/stopTelemetry
 * （启停本地扫描 worker），面板开关无需自己接 worker。
 */

export interface TaskBusSettingsLike {
  enabled?: boolean;
  telemetry?: { enabled?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

export async function readTaskBusSettings(): Promise<TaskBusSettingsLike> {
  const response = await fetch('/api/settings/task-bus');
  return (await response.json().catch(() => ({}))) as TaskBusSettingsLike;
}

/** 读取上报总开关（telemetry.enabled；文件缺失/字段缺失视为未开启） */
export async function readUsageReportingEnabled(): Promise<boolean> {
  const settings = await readTaskBusSettings();
  return settings.telemetry?.enabled === true;
}

/** 写上报总开关（保留 taskBus 其他字段；PUT 内部联动启停 telemetry worker） */
export async function writeUsageReportingEnabled(enabled: boolean): Promise<void> {
  const current = await readTaskBusSettings();
  const next: TaskBusSettingsLike = {
    ...current,
    telemetry: { ...(current.telemetry ?? {}), enabled },
  };
  const response = await fetch('/api/settings/task-bus', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `保存上报设置失败（HTTP ${response.status}）`);
}

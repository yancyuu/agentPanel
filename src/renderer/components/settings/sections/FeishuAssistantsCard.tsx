import { useCallback, useEffect, useState } from 'react';

import { AlertTriangle, Bot, Check, Loader2, Plus, RefreshCw } from 'lucide-react';

import { SettingsSectionCard } from '../components';

interface FeishuAssistantProject {
  name: string;
  teamSlug: string;
  status: string;
}

interface OperationOutcome {
  ok: boolean;
  at: string;
  text: string;
}

function OutcomeLine({ outcome }: Readonly<{ outcome: OperationOutcome }>): React.JSX.Element {
  const date = new Date(outcome.at);
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <p
      className={`flex items-start gap-1.5 text-[11px] leading-4 ${
        outcome.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
      }`}
      data-testid="feishu-assistant-outcome"
    >
      {outcome.ok ? (
        <Check size={12} className="mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{outcome.text}</span>
      <span className="shrink-0 text-[var(--color-text-muted)]">{time}</span>
    </p>
  );
}

/**
 * 飞书个人助理（与 CLI create-feishu-assistant/list-feishu-assistants 等价）：
 * 列表 + 创建，复用服务端 /api/feishu-assistants（bin/lib 同一实现）。
 */
export const FeishuAssistantsCard = (): React.JSX.Element => {
  const [projects, setProjects] = useState<FeishuAssistantProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OperationOutcome | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/feishu-assistants');
      const payload = (await response.json()) as {
        ok: boolean;
        projects?: FeishuAssistantProject[];
        message?: string;
      };
      setProjects(Array.isArray(payload.projects) ? payload.projects : []);
      if (!payload.ok && payload.message) {
        setOutcome({ ok: false, at: new Date().toISOString(), text: payload.message });
      }
    } catch (error) {
      setOutcome({
        ok: false,
        at: new Date().toISOString(),
        text: error instanceof Error ? error.message : '读取助理列表失败',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/feishu-assistants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        alreadyExists?: boolean;
        teamSlug?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.message || `创建失败（HTTP ${response.status}）`);
      }
      setOutcome({
        ok: true,
        at: new Date().toISOString(),
        text: payload.alreadyExists
          ? `「${name.trim()}」已存在，无需重复创建。`
          : `飞书个人助理「${payload.teamSlug ?? name.trim()}」已创建。`,
      });
      setName('');
      setDescription('');
      setCreating(false);
      await load();
    } catch (error) {
      setOutcome({
        ok: false,
        at: new Date().toISOString(),
        text: error instanceof Error ? error.message : '创建失败',
      });
    } finally {
      setBusy(false);
    }
  }, [busy, description, load, name]);

  return (
    <SettingsSectionCard
      title="飞书个人助理"
      description="创建和管理飞书上的个人助理（与 CLI create-feishu-assistant 等价）。"
      icon={<Bot className="size-3.5" />}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
            已有助理（{projects.length}）
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="grid size-7 place-items-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label="刷新助理列表"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            正在读取助理列表…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">
            还没有飞书个人助理。
          </div>
        ) : (
          <ul className="space-y-1">
            {projects.map((project) => (
              <li
                key={project.teamSlug}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--color-surface-hover)]"
              >
                <Bot size={13} className="shrink-0 text-indigo-400" />
                <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                  {project.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                  {project.teamSlug}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {project.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        {creating ? (
          <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="助理名称（必填，例如：小助手）"
              className="h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 text-xs outline-none focus:border-indigo-500"
            />
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="擅长什么（可选）"
              className="h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2.5 text-xs outline-none focus:border-indigo-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!name.trim() || busy}
                onClick={() => void create()}
                className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                创建
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          >
            <Plus size={12} />
            创建飞书个人助理
          </button>
        )}

        {outcome ? <OutcomeLine outcome={outcome} /> : null}
      </div>
    </SettingsSectionCard>
  );
};

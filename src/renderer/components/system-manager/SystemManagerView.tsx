import { useCallback, useEffect, useMemo, useState } from 'react';

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { buildCapabilityPackCommandSuggestions } from '@renderer/utils/slashCommandRegistry';
import { SYSTEM_MANAGER_TEAM_NAME } from '@shared/types/team';
import { Settings2 } from 'lucide-react';

import { RuntimeConfigDialog } from '../team/dialogs/RuntimeConfigDialog';
import { LoopConsolePanel } from '../team/loop-console/LoopConsolePanel';

import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  CcSession,
  ResolvedTeamMember,
  TeamTaskWithKanban,
  TeamViewSnapshot,
} from '@shared/types';
import type { SystemManagerConfig, SystemManagerStatus } from '@shared/types/systemManager';

interface SystemManagerViewProps {
  isPaneFocused?: boolean;
  isActive?: boolean;
}

function formatPathForTitle(pathValue: string): string {
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined;
  if (home && pathValue.startsWith(home)) return `~${pathValue.slice(home.length)}`;
  return pathValue;
}

const EMPTY_ADMIN_TASKS: TeamTaskWithKanban[] = [];
const EMPTY_CAPABILITY_PACKS = [] as const;
const NOOP_FETCH_CAPABILITY_PACKS = (): Promise<void> => Promise.resolve();

function buildAdminLoopMember(teamData: TeamViewSnapshot | null): ResolvedTeamMember[] {
  const lead = teamData?.members[0];
  return [
    {
      name: SYSTEM_MANAGER_TEAM_NAME,
      agentId: lead?.agentId,
      status: teamData?.isAlive ? 'active' : 'idle',
      currentTaskId: null,
      taskCount: teamData?.tasks.length ?? 0,
      lastActiveAt: null,
      messageCount: 0,
      color: 'slate',
      agentType: 'admin-loop',
      role: 'Workspace loop manager',
      workflow: lead?.workflow,
      providerId: lead?.providerId,
      model: lead?.model,
      effort: lead?.effort,
      cwd: teamData?.config.projectPath,
      gitBranch: lead?.gitBranch,
      runtimeAdvisory: lead?.runtimeAdvisory,
    },
  ];
}

export const SystemManagerView = ({
  isPaneFocused: _isPaneFocused = false,
  isActive: _isActive = true,
}: SystemManagerViewProps): React.JSX.Element => {
  const [status, setStatus] = useState<SystemManagerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminTeamData, setAdminTeamData] = useState<TeamViewSnapshot | null>(null);
  const [adminSessions, setAdminSessions] = useState<CcSession[]>([]);
  const [pendingRepliesByMember, setPendingRepliesByMember] = useState<Record<string, number>>({});
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capabilityPacks = useStore((state) => state.capabilityPacks ?? EMPTY_CAPABILITY_PACKS);
  const fetchCapabilityPacks = useStore(
    (state) => state.fetchCapabilityPacks ?? NOOP_FETCH_CAPABILITY_PACKS
  );

  const load = useCallback(async (): Promise<SystemManagerConfig | null> => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextConfig] = await Promise.all([
        api.systemManager.getStatus(),
        api.systemManager.getConfig(),
        fetchCapabilityPacks().then(() => undefined),
      ]);
      await api.teams.ensureSystemManager();
      const [nextTeamData, nextSessions] = await Promise.all([
        api.teams.getData(SYSTEM_MANAGER_TEAM_NAME),
        api.teams.getTeamSessions(SYSTEM_MANAGER_TEAM_NAME),
      ]);
      setStatus(nextStatus);
      setAdminTeamData(nextTeamData);
      setAdminSessions(nextSessions);
      return nextConfig;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetchCapabilityPacks]);

  useEffect(() => {
    void load();
  }, [load]);

  const adminWorkflowCommandSuggestions = useMemo<MentionSuggestion[]>(
    () => buildCapabilityPackCommandSuggestions(capabilityPacks, 'admin-loop', {}),
    [capabilityPacks]
  );
  const adminMembers = useMemo(() => buildAdminLoopMember(adminTeamData), [adminTeamData]);
  const adminTasks = adminTeamData?.tasks ?? EMPTY_ADMIN_TASKS;
  const localStatusLabel = status?.localStatus === 'ready' ? '本地可用' : '本地异常';

  return (
    <div className="flex size-full min-w-0 flex-col overflow-hidden bg-page-canvas text-[var(--color-text)]">
      <WorkbenchPageHeader
        title="Helm Loop"
        description="执行全局巡检、诊断、复盘、治理和改进提案。"
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-[var(--color-text-muted)] sm:inline">
              {loading ? '正在连接' : localStatusLabel}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 border-[var(--surface-border)]"
              onClick={() => setBindingDialogOpen(true)}
            >
              <Settings2 size={13} />
              运行时
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <section
            aria-label="Helm Loop 运行边界"
            className="grid gap-px overflow-hidden rounded-md border border-[var(--surface-border)] bg-[var(--surface-border)] text-xs sm:grid-cols-3"
          >
            <div className="min-w-0 bg-[var(--color-surface)] px-3 py-2.5">
              <p className="text-[11px] text-[var(--color-text-muted)]">作用域</p>
              <p
                className="mt-1 truncate text-[var(--color-text-secondary)]"
                title={status?.adminWorkDir}
              >
                {formatPathForTitle(status?.adminWorkDir ?? '—')}
              </p>
            </div>
            <div className="min-w-0 bg-[var(--color-surface)] px-3 py-2.5">
              <p className="text-[11px] text-[var(--color-text-muted)]">命令源</p>
              <p className="mt-1 truncate text-[var(--color-text-secondary)]">
                当前工作区 .claude/commands
              </p>
            </div>
            <div className="min-w-0 bg-[var(--color-surface)] px-3 py-2.5">
              <p className="text-[11px] text-[var(--color-text-muted)]">默认边界</p>
              <p className="mt-1 truncate text-[var(--color-text-secondary)]">
                只读、报告和提案优先
              </p>
            </div>
          </section>

          {(error || loading) && (
            <div
              role={error ? 'alert' : 'status'}
              className="rounded-md border border-[var(--surface-border)] bg-[var(--color-surface)] px-3 py-2 text-xs"
            >
              {error ? <div className="text-red-300">{error}</div> : null}
              {loading ? (
                <div className="text-[var(--color-text-muted)]">正在加载 Helm Loop 配置...</div>
              ) : null}
            </div>
          )}

          <LoopConsolePanel
            teamName={SYSTEM_MANAGER_TEAM_NAME}
            members={adminMembers}
            tasks={adminTasks}
            isTeamAlive={status?.localStatus === 'ready'}
            statusLabel={localStatusLabel}
            sessionPendingRecipient={SYSTEM_MANAGER_TEAM_NAME}
            isProvisioning={loading}
            currentLeadSessionId={adminTeamData?.config.leadSessionId}
            leadProjectPath={adminTeamData?.config.projectPath}
            sessions={adminSessions}
            commandSuggestions={adminWorkflowCommandSuggestions}
            slashCommandMode="session"
            pendingRepliesByMember={pendingRepliesByMember}
            onPendingReplyChange={setPendingRepliesByMember}
          />
        </div>
      </div>
      <RuntimeConfigDialog
        open={bindingDialogOpen}
        teamName={SYSTEM_MANAGER_TEAM_NAME}
        onClose={() => setBindingDialogOpen(false)}
      />
    </div>
  );
};

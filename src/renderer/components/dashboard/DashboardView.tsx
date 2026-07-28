import React from 'react';

import { WorkbenchPageHeader } from '@features/collaborative-workbench/renderer';
import { RecentProjectsSection } from '@features/recent-projects/renderer';
import { useStore } from '@renderer/store';
import { Bot, Inbox, MessageCircle, Settings, ShieldCheck, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

const DASHBOARD_BOUNDARIES = [
  {
    title: '本地优先',
    description: '项目、运行时、执行记录与团队数据默认保留在本机。',
  },
  {
    title: '团队协作',
    description: '围绕任务组织 Agent、负责人、评审和交付状态。',
  },
  {
    title: '持续改进',
    description: '通过 Loop 工作流执行巡检、复盘和治理提案。',
  },
] as const;

export const DashboardView = (): React.JSX.Element => {
  const {
    openChatTab,
    openSettingsTab,
    openSystemManager,
    openTasksTab,
    openTeamsTab,
    teams,
    teamsLoading,
  } = useStore(
    useShallow((state) => ({
      openChatTab: state.openChatTab,
      openSettingsTab: state.openSettingsTab,
      openSystemManager: state.openSystemManager,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Zustand actions do not use `this`; preserve the stable store function reference.
      openTasksTab: state.openTasksTab,
      openTeamsTab: state.openTeamsTab,
      teams: state.teams,
      teamsLoading: state.teamsLoading,
    }))
  );
  const showQuickstartGuide = !teamsLoading && teams.length === 0;

  const quickActions = [
    {
      label: '打开收件箱',
      description: '查看需要关注、评审或继续推进的任务。',
      icon: Inbox,
      onClick: openTasksTab,
    },
    {
      label: '团队与 Agent',
      description: '查看团队成员、运行状态和当前负责人。',
      icon: Users,
      onClick: openTeamsTab,
    },
    {
      label: 'Helm Loop',
      description: '执行全局巡检、诊断和持续改进工作流。',
      icon: Bot,
      onClick: () => void openSystemManager(),
    },
    {
      label: '配置 Harness',
      description: '检查并配置 Claude、Codex 或 Gemini 等运行时。',
      icon: Settings,
      onClick: () => openSettingsTab('harness'),
    },
    {
      label: '飞书协作',
      description: '进入现有渠道会话和团队消息入口。',
      icon: MessageCircle,
      onClick: openChatTab,
    },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-page-canvas">
      <WorkbenchPageHeader title="工作台" description="从任务、团队和 Loop 入口继续本地协作。" />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
          <section aria-labelledby="dashboard-quick-actions-title">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 id="dashboard-quick-actions-title" className="text-sm font-medium text-text">
                  快速入口
                </h2>
                <p className="mt-0.5 text-xs text-text-muted">选择下一项协作工作。</p>
              </div>
              <span className="text-xs tabular-nums text-text-muted">
                {teamsLoading ? '正在同步团队' : `${teams.length} 个团队`}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {quickActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    className="group rounded-md border border-[var(--surface-border)] bg-[var(--color-surface)] p-3 text-left transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-text">
                      <Icon className="size-4 text-text-muted transition-colors group-hover:text-text" />
                      {action.label}
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-text-muted">{action.description}</p>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            aria-label="工作区边界"
            className="grid gap-px overflow-hidden rounded-md border border-[var(--surface-border)] bg-[var(--surface-border)] md:grid-cols-3"
          >
            {DASHBOARD_BOUNDARIES.map((item) => (
              <div key={item.title} className="bg-[var(--color-surface)] px-3 py-2.5">
                <p className="text-xs font-medium text-text-secondary">{item.title}</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">{item.description}</p>
              </div>
            ))}
          </section>

          {showQuickstartGuide ? (
            <section className="rounded-md border border-[var(--surface-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <ShieldCheck className="size-4 text-text-muted" />
                快速开始
              </div>
              <p className="mt-1 text-xs text-text-muted">
                先连接可用的 Agent 运行时，再创建团队并开始分发任务。
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => openSettingsTab('harness')}
                  className="rounded-md border border-[var(--surface-border)] bg-page-canvas p-3 text-left transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <p className="flex items-center gap-2 text-sm font-medium text-text">
                    <Settings className="size-4" />
                    配置 Harness
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    连接 Claude、Codex 或 Gemini 等运行时。
                  </p>
                </button>
                <button
                  type="button"
                  onClick={openTeamsTab}
                  className="rounded-md border border-[var(--surface-border)] bg-page-canvas p-3 text-left transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <p className="flex items-center gap-2 text-sm font-medium text-text">
                    <Users className="size-4" />
                    创建团队并启动
                  </p>
                  <p className="mt-1 text-xs text-text-muted">设置工作目录后即可开始分发任务。</p>
                </button>
              </div>
            </section>
          ) : (
            <section aria-labelledby="recent-projects-title">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h2 id="recent-projects-title" className="text-sm font-medium text-text">
                    最近打开的项目
                  </h2>
                  <p className="mt-0.5 text-xs text-text-muted">继续最近的本地工作区。</p>
                </div>
                <button
                  type="button"
                  onClick={() => void openSystemManager()}
                  className="shrink-0 text-xs text-text-muted transition-colors hover:text-text"
                >
                  打开 Helm Loop
                </button>
              </div>
              <RecentProjectsSection searchQuery="" />
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

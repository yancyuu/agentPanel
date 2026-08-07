import { Button } from '@renderer/components/ui/button';

import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES } from './HarnessCards';
import { HarnessIcon } from './HarnessSelect';

import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

interface TeamEmptyStateProps {
  canCreate: boolean;
  onCreateTeam: () => void;
  onSelectHarness?: (harness: HermitBridgeAgentType) => void;
}

const HARNESS_DESCRIPTIONS: Record<HermitBridgeAgentType, string> = {
  claudecode: 'Anthropic 官方 CLI',
  codex: 'OpenAI Codex CLI',
  cursor: 'Cursor IDE Agent',
  gemini: 'Google Gemini CLI',
  iflow: 'iFlow CLI',
  kimi: 'Moonshot Kimi',
  devin: 'Cognition Devin',
  opencode: 'OpenCode CLI',
  qoder: 'Qoder CLI',
  pi: 'Inflection Pi',
  acp: 'Agent Communication Protocol',
  tmux: 'Tmux Session',
};

export const TeamEmptyState = ({
  canCreate,
  onCreateTeam,
  onSelectHarness,
}: TeamEmptyStateProps): React.JSX.Element => {
  return (
    <div className="flex size-full min-h-[420px] flex-col items-center justify-center gap-6 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-10">
      <div className="max-w-md text-center">
        <p className="text-base font-medium text-[var(--color-text)]">创建第一个团队</p>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
          选择一种 Agent 运行方式，建立包含负责人和协作成员的本地团队。
        </p>
      </div>

      {/* Harness 卡片网格 */}
      {onSelectHarness && (
        <div className="w-full max-w-2xl">
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Agent 运行方式
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {ALL_AGENT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="flex flex-col items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-center transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                onClick={() => onSelectHarness(type)}
              >
                <HarnessIcon type={type} className="size-6" />
                <span className="text-xs font-medium text-[var(--color-text)]">
                  {AGENT_TYPE_LABELS[type]}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {HARNESS_DESCRIPTIONS[type]}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="h-px w-12 bg-[var(--color-border)]" />
        <span className="text-xs text-[var(--color-text-muted)]">或</span>
        <div className="h-px w-12 bg-[var(--color-border)]" />
      </div>

      <Button
        size="sm"
        className="bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent)] hover:opacity-90"
        disabled={!canCreate}
        onClick={onCreateTeam}
      >
        创建自定义团队
      </Button>

      {!canCreate && (
        <p className="text-xs text-[var(--color-text-muted)]">当前环境不支持创建本地团队。</p>
      )}
    </div>
  );
};

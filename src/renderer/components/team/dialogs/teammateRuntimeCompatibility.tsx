import { parseCliArgs } from '@shared/utils/cliArgsParser';

import type { TeamProviderId } from '@shared/types';

interface RuntimeMemberInput {
  id?: string;
  name: string;
  providerId?: TeamProviderId;
  providerBackendId?: string | null;
  removedAt?: number | string | null;
}

export interface TeammateRuntimeCompatibility {
  visible: boolean;
  blocksSubmission: boolean;
  checking: boolean;
  title: string;
  message: string;
  details: string[];
  tmuxDetail: string | null;
  memberWarningById: Record<string, string>;
}

interface AnalyzeTeammateRuntimeCompatibilityInput {
  leadProviderId: TeamProviderId;
  leadProviderBackendId?: string | null;
  members: readonly RuntimeMemberInput[];
  soloTeam?: boolean;
  extraCliArgs?: string;
  tmuxStatus?: unknown;
  tmuxStatusLoading?: boolean;
  tmuxStatusError?: string | null;
}

const PROVIDER_LABELS: Record<TeamProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

function getProviderLabel(providerId: TeamProviderId): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function getExplicitTeammateMode(
  rawExtraCliArgs: string | undefined
): 'auto' | 'tmux' | 'in-process' | null {
  const tokens = parseCliArgs(rawExtraCliArgs);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // eslint-disable-next-line security/detect-possible-timing-attacks -- parsing UI CLI flags, not comparing secrets
    if (token === '--teammate-mode') {
      const value = tokens[index + 1];
      return value === 'auto' || value === 'tmux' || value === 'in-process' ? value : null;
    }
    if (token.startsWith('--teammate-mode=')) {
      const value = token.slice('--teammate-mode='.length);
      return value === 'auto' || value === 'tmux' || value === 'in-process' ? value : null;
    }
  }
  return null;
}

const NO_RUNTIME_COMPATIBILITY_ISSUE: TeammateRuntimeCompatibility = {
  visible: false,
  blocksSubmission: false,
  checking: false,
  title: '',
  message: '',
  details: [],
  tmuxDetail: null,
  memberWarningById: {},
};

export function analyzeTeammateRuntimeCompatibility({
  leadProviderId,
  members,
  soloTeam = false,
  extraCliArgs,
}: AnalyzeTeammateRuntimeCompatibilityInput): TeammateRuntimeCompatibility {
  const activeMembers = soloTeam
    ? []
    : members.filter((member) => member.removedAt == null && member.name.trim().length > 0);
  const explicitTeammateMode = getExplicitTeammateMode(extraCliArgs);

  if (explicitTeammateMode !== 'tmux' || activeMembers.length === 0) {
    return NO_RUNTIME_COMPATIBILITY_ISSUE;
  }

  return {
    visible: true,
    blocksSubmission: false,
    checking: false,
    title: '已切换为进程内成员运行',
    message: `当前 Loop runtime 会通过 ${getProviderLabel(leadProviderId)} Loop Lead 会话启动成员，不再依赖 tmux。`,
    details: ['自定义 CLI 参数里的 --teammate-mode tmux 会被忽略，并改为 in-process。'],
    tmuxDetail: null,
    memberWarningById: {},
  };
}

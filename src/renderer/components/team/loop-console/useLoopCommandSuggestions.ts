import { useEffect, useMemo } from 'react';

import { useProjectWorkflowCommands } from '@renderer/hooks/useProjectWorkflowCommands';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { getSuggestedSlashCommandsForProvider } from '@renderer/utils/providerSlashCommands';
import { buildSlashCommandSuggestions } from '@renderer/utils/skillCommandSuggestions';
import { CANONICAL_LEAD_MEMBER_NAME, isLeadMember } from '@shared/utils/leadDetection';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

interface UseLoopCommandSuggestionsOptions {
  teamName: string;
  members: ResolvedTeamMember[];
  commandSuggestions?: MentionSuggestion[];
  /** Team project path — used to load that project's commands/workflows and skills. */
  projectPath?: string | null;
}

interface UseLoopCommandSuggestionsResult {
  mentionSuggestions: MentionSuggestion[];
  teamSuggestions: MentionSuggestion[];
  taskSuggestions: MentionSuggestion[];
  commandSuggestions: MentionSuggestion[];
  leadRecipient: string;
}

function formatRole(role?: string): string | undefined {
  const value = role?.trim();
  if (!value) return undefined;
  return value;
}

function isBlockedCommandSuggestion(suggestion: MentionSuggestion): boolean {
  const raw = (suggestion.command ?? suggestion.name).trim().toLowerCase().replace(/^\//, '');
  return raw === 'loop' || raw === 'system' || raw.endsWith(':loop') || raw.endsWith(':system');
}

export function useLoopCommandSuggestions({
  teamName,
  members,
  commandSuggestions: scopedCommandSuggestions,
  projectPath,
}: UseLoopCommandSuggestionsOptions): UseLoopCommandSuggestionsResult {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((member) => ({
        id: member.name,
        name: member.name,
        subtitle: formatRole(member.role) ?? formatRole(member.agentType),
        color: colorMap.get(member.name),
      })),
    [colorMap, members]
  );

  const leadMember = useMemo(
    () => members.find((member) => isLeadMember(member)) ?? members[0],
    [members]
  );
  const leadRecipient = leadMember?.name ?? CANONICAL_LEAD_MEMBER_NAME;
  const leadProviderId = useMemo(
    () =>
      normalizeOptionalTeamProviderId(leadMember?.providerId) ??
      inferTeamProviderIdFromModel(leadMember?.model),
    [leadMember?.model, leadMember?.providerId]
  );

  const skillsProjectCatalogByProjectPath = useStore(
    (state) => state.skillsProjectCatalogByProjectPath
  );
  const fetchSkillsCatalog = useStore((state) => state.fetchSkillsCatalog);

  useEffect(() => {
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchSkillsCatalog, projectPath]);

  const { suggestions: teamSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  // Load the team project's own executable assets so project-specific commands,
  // workflows and skills appear in every team console. Caller-supplied scoped
  // commands are additive (e.g. 诊断 capability-pack commands), not a
  // replacement for the current team's project/workspace assets.
  const projectWorkflowSuggestions = useProjectWorkflowCommands(projectPath);
  const projectSkills = projectPath ? (skillsProjectCatalogByProjectPath[projectPath] ?? []) : [];
  const commandSuggestions = useMemo<MentionSuggestion[]>(() => {
    const projectSkillSuggestions = buildSlashCommandSuggestions(
      [],
      projectSkills,
      [],
      leadProviderId
    );
    const baseSuggestions = buildSlashCommandSuggestions(
      getSuggestedSlashCommandsForProvider(leadProviderId),
      [],
      [],
      leadProviderId
    );

    // 团队指令台优先显示当前项目资产：commands/workflows > project skills > 调用方注入命令 > 基础命令。
    // 诊断 的运维 workflow 由 SystemManagerView 注入，但不能替代当前团队项目资产。
    const localSuggestions = [
      ...projectWorkflowSuggestions,
      ...projectSkillSuggestions,
      ...(scopedCommandSuggestions ?? []),
      ...baseSuggestions,
    ];
    const seen = new Set<string>();
    return localSuggestions.filter((suggestion) => {
      if (isBlockedCommandSuggestion(suggestion)) return false;
      const key = suggestion.command ?? suggestion.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [leadProviderId, projectSkills, projectWorkflowSuggestions, scopedCommandSuggestions]);

  return {
    mentionSuggestions,
    teamSuggestions,
    taskSuggestions,
    commandSuggestions,
    leadRecipient,
  };
}

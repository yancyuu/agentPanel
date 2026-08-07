import { useCallback, useMemo, useState } from 'react';

import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  expandCapabilityCommand,
  resolveCapabilityCommandInput,
  type SelectedCapabilityCommandRef,
} from '@renderer/utils/capabilityCommandExecution';
import {
  buildSlashCommandRegistry,
  collectSlashSuggestionAliases,
  RESERVED_SLASH_COMMANDS,
} from '@renderer/utils/slashCommandRegistry';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import {
  expandWorkflowCommand,
  resolveWorkflowCommandInput,
} from '@renderer/utils/workflowCommandExecution';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { Send, TerminalSquare } from 'lucide-react';

import { type LoopSendIntent, parseLoopSendIntent, validateLoopSendIntent } from './loopSendIntent';
import { useLoopCommandSuggestions } from './useLoopCommandSuggestions';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

interface LoopCommandComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  isProvisioning?: boolean;
  sending?: boolean;
  commandSuggestions?: MentionSuggestion[];
  slashCommandMode?: 'message' | 'session';
  /** Team project path — loads that project's .claude/commands as commands. */
  projectPath?: string | null;
  onSubmit: (intent: LoopSendIntent) => Promise<boolean | void> | boolean | void;
}

const EMPTY_CHIPS: InlineChip[] = [];

export const LoopCommandComposer = ({
  teamName,
  members,
  isTeamAlive,
  isProvisioning,
  sending = false,
  commandSuggestions: scopedCommandSuggestions,
  slashCommandMode = 'message',
  projectPath,
  onSubmit,
}: LoopCommandComposerProps): React.JSX.Element => {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<SelectedCapabilityCommandRef | null>(null);
  const capabilityPacks = useStore((state) => state.capabilityPacks);
  const {
    mentionSuggestions,
    teamSuggestions,
    taskSuggestions,
    commandSuggestions,
    leadRecipient,
  } = useLoopCommandSuggestions({
    teamName,
    members,
    commandSuggestions: scopedCommandSuggestions,
    projectPath,
  });

  const trimmed = stripEncodedTaskReferenceMetadata(text).trim();
  const taskRefs = useMemo(
    () => extractTaskRefsFromText(text, taskSuggestions),
    [taskSuggestions, text]
  );
  const capabilityRegistry = useMemo(
    () =>
      buildSlashCommandRegistry({
        packs: capabilityPacks,
        scope: slashCommandMode === 'session' ? 'admin-loop' : 'team-loop',
      }),
    [capabilityPacks, slashCommandMode]
  );
  const shadowedAliases = useMemo(() => {
    const aliases = new Set(RESERVED_SLASH_COMMANDS);
    for (const alias of collectSlashSuggestionAliases(
      commandSuggestions.filter((suggestion) => !suggestion.commandRef)
    )) {
      aliases.add(alias);
    }
    return aliases;
  }, [commandSuggestions]);
  const capabilityCommandResult = useMemo(
    () =>
      resolveCapabilityCommandInput(capabilityRegistry, trimmed, selectedCommand, {
        shadowedAliases,
      }),
    [capabilityRegistry, selectedCommand, shadowedAliases, trimmed]
  );
  // Workflow-folder prompts (`.claude/commands/*.md`) carry no commandRef, so the
  // capability resolver intentionally returns not-found for them. Resolve them here
  // so their full prompt content can be injected on submit instead of sending raw /name.
  const workflowCommandResult = useMemo(
    () => resolveWorkflowCommandInput(commandSuggestions, trimmed),
    [commandSuggestions, trimmed]
  );
  const intent = useMemo(
    () =>
      parseLoopSendIntent({
        text: serializeChipsWithText(trimmed, EMPTY_CHIPS),
        recipient: leadRecipient,
        leadRecipient,
        taskRefs,
        slashCommandMode,
      }),
    [leadRecipient, slashCommandMode, taskRefs, trimmed]
  );
  const validation = validateLoopSendIntent(intent, { isTeamAlive, isProvisioning });
  const conflictReason =
    capabilityCommandResult.status === 'conflict' ? capabilityCommandResult.conflictLabel : null;
  const canSend =
    validation.ok &&
    !conflictReason &&
    !sending &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH;
  const remaining = MAX_TEXT_LENGTH - trimmed.length;

  const handleSubmit = useCallback(() => {
    if (!canSend) {
      if (conflictReason) setFeedback(conflictReason);
      else if (!validation.ok) setFeedback(validation.reason ?? null);
      return;
    }
    setFeedback(null);
    const submit = async () => {
      if (capabilityCommandResult.status === 'resolved' && capabilityCommandResult.resolved) {
        const scope = slashCommandMode === 'session' ? 'admin-loop' : 'team-loop';
        const expanded = await expandCapabilityCommand(capabilityCommandResult.resolved, scope);
        const nextIntent: LoopSendIntent =
          expanded.registered.command.execution?.type === 'loop-session'
            ? {
                kind: 'session',
                text: expanded.text,
                summary: expanded.summary,
                sessionName: expanded.registered.namespacedSlash.slice(1),
                reuse: expanded.registered.command.execution?.reuse ?? true,
              }
            : {
                kind: 'message',
                recipient: leadRecipient,
                text: expanded.text,
                summary: expanded.summary,
                taskRefs,
                slashCommand: expanded.slashCommand,
              };
        return onSubmit(nextIntent);
      }
      if (workflowCommandResult) {
        // Inject the workflow prompt's full content (loaded from the commands folder)
        // so the agent actually receives the workflow body, not the literal "/name".
        const expanded = await expandWorkflowCommand(workflowCommandResult);
        const nextIntent: LoopSendIntent =
          slashCommandMode === 'session'
            ? {
                kind: 'session',
                text: expanded.text,
                summary: expanded.summary,
                sessionName: expanded.slashCommand.name,
                reuse: true,
                workflowPrompt: expanded.prompt,
              }
            : {
                kind: 'message',
                recipient: leadRecipient,
                text: expanded.text,
                summary: expanded.summary,
                taskRefs,
                slashCommand: expanded.slashCommand,
              };
        return onSubmit(nextIntent);
      }
      return onSubmit(intent);
    };
    void Promise.resolve(submit())
      .then((accepted) => {
        if (accepted !== false) {
          setText('');
          setSelectedCommand(null);
        }
      })
      .catch((error: unknown) => {
        setFeedback(error instanceof Error ? error.message : '命令执行失败');
      });
  }, [
    canSend,
    capabilityCommandResult,
    conflictReason,
    intent,
    leadRecipient,
    onSubmit,
    slashCommandMode,
    taskRefs,
    validation.ok,
    validation.reason,
    workflowCommandResult,
  ]);

  return (
    <div className="rounded-xl border border-indigo-500/20 bg-[var(--color-surface-raised)] p-2 shadow-sm">
      <div className="mb-2 flex items-center gap-2 px-1 text-[10px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1 font-medium text-indigo-300">
          <TerminalSquare size={11} />
          cmd
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {intent.kind === 'runtime'
            ? '仅注入 runtime'
            : intent.kind === 'session'
              ? '本地会话'
              : intent.kind === 'workers-list'
                ? '查看数字员工'
                : '发送给 Lead'}
        </span>
      </div>

      <MentionableTextarea
        id={`loop-console-${teamName}`}
        placeholder='输入指令：/help、/model、!runtime、!session --name "巡检"…'
        value={text}
        onValueChange={setText}
        suggestions={mentionSuggestions}
        teamSuggestions={teamSuggestions}
        taskSuggestions={taskSuggestions}
        commandSuggestions={commandSuggestions}
        chips={EMPTY_CHIPS}
        onModEnter={handleSubmit}
        extraTips={[
          '输入 / 查看可用命令；输入 !runtime 表示只注入运行时；输入 !session 新建本地会话。',
        ]}
        surfaceClassName="bg-[var(--color-surface)]"
        surfaceFadeColor="var(--color-surface)"
        className="border-[var(--color-border-subtle)] shadow-none"
        minRows={2}
        maxRows={7}
        maxLength={MAX_TEXT_LENGTH}
        disabled={sending}
        onSuggestionSelected={(suggestion, insertedText) => {
          if (
            suggestion.type === 'command' &&
            suggestion.commandRef &&
            insertedText.startsWith('/')
          ) {
            setSelectedCommand({
              commandRef: suggestion.commandRef,
              command: insertedText as `/${string}`,
            });
          } else {
            setSelectedCommand(null);
          }
        }}
        hintText={undefined}
        cornerActionInset="compact"
        cornerAction={
          <button
            type="button"
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-medium shadow-sm transition-colors',
              canSend
                ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                : 'cursor-not-allowed bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] opacity-60'
            )}
            disabled={!canSend}
            onClick={handleSubmit}
          >
            <Send size={12} />
            执行
          </button>
        }
        footerRight={
          <div className="flex items-center gap-2 text-[10px]">
            {feedback || !validation.ok ? (
              <span className="text-amber-300">{feedback ?? validation.reason}</span>
            ) : null}
            {remaining < 200 ? (
              <span
                className={remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}
              >
                剩余 {remaining} 字符
              </span>
            ) : null}
          </div>
        }
      />
    </div>
  );
};

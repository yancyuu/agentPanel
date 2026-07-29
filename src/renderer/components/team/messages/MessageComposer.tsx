import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { OpenCodeDeliveryWarning } from '@renderer/components/team/messages/OpenCodeDeliveryWarning';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { useProjectWorkflowCommands } from '@renderer/hooks/useProjectWorkflowCommands';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  expandCapabilityCommand,
  resolveCapabilityCommandInput,
  type SelectedCapabilityCommandRef,
} from '@renderer/utils/capabilityCommandExecution';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { getSuggestedSlashCommandsForProvider } from '@renderer/utils/providerSlashCommands';
import { buildSlashCommandSuggestions } from '@renderer/utils/skillCommandSuggestions';
import {
  buildCapabilityPackCommandSuggestions,
  buildSlashCommandRegistry,
  collectSlashSuggestionAliases,
  RESERVED_SLASH_COMMANDS,
} from '@renderer/utils/slashCommandRegistry';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';
import { AlertCircle, Check, ChevronDown, Mic, Paperclip, Search, Send } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  AgentActionMode,
  AttachmentPayload,
  ResolvedTeamMember,
  SendMessageResult,
  SlashCommandMeta,
  TaskRef,
} from '@shared/types';

interface MessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  layout?: 'default' | 'compact';
  /** Render a wider, quieter mail-style body editor without the chat recipient pill. */
  mailMode?: boolean;
  minRows?: number;
  maxRows?: number;
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  sendWarning?: string | null;
  sendDebugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastResult?: SendMessageResult | null;
  /** Lock the composer to one employee when rendered inside an inbox thread. */
  fixedRecipient?: string;
  /** Thread-scoped draft persistence key. Defaults to the team name. */
  draftKey?: string;
  placeholder?: string;
  sendLabel?: string;
  initialText?: string;
  /** Ref to the underlying textarea element for external focus management. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: AgentActionMode,
    taskRefs?: TaskRef[],
    slashCommand?: SlashCommandMeta
  ) => void;
}

export const MessageComposer = ({
  teamName,
  members,
  layout = 'default',
  mailMode = false,
  minRows,
  maxRows,
  isTeamAlive,
  sending,
  sendError,
  sendWarning,
  sendDebugDetails,
  lastResult,
  fixedRecipient,
  draftKey,
  placeholder,
  sendLabel = '下发',
  initialText,
  textareaRef: externalTextareaRef,
  onSend,
}: MessageComposerProps): React.JSX.Element => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = useMemo(() => {
    // Merge internal and external refs into a single callback ref
    return (node: HTMLTextAreaElement | null) => {
      (internalTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      if (typeof externalTextareaRef === 'function') {
        externalTextareaRef(node);
      } else if (externalTextareaRef) {
        (externalTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      }
    };
  }, [externalTextareaRef]);
  const [recipient, setRecipient] = useState<string>(() => {
    if (fixedRecipient?.trim()) return fixedRecipient.trim();
    const lead = members.find((m) => isLeadMember(m));
    return lead?.name ?? members[0]?.name ?? '';
  });
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const recipientSearchRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileRestrictionError, setFileRestrictionError] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<SelectedCapabilityCommandRef | null>(null);
  const fileRestrictionTimerRef = useRef(0);
  const dismissMentionsRef = useRef<(() => void) | null>(null);

  // Members load async with team data; keep recipient stable if valid, otherwise default to lead/first.
  useEffect(() => {
    const lockedRecipient = fixedRecipient?.trim();
    if (lockedRecipient) {
      if (lockedRecipient !== recipient) queueMicrotask(() => setRecipient(lockedRecipient));
      return;
    }
    if (recipient && members.some((m) => m.name === recipient)) {
      return;
    }
    const lead = members.find((m) => isLeadMember(m));
    const next = lead?.name ?? members[0]?.name ?? '';
    if (next && next !== recipient) {
      queueMicrotask(() => setRecipient(next));
    }
  }, [fixedRecipient, members, recipient]);

  const projectPath = useStore((s) =>
    s.selectedTeamName === teamName ? (s.selectedTeamData?.config.projectPath ?? null) : null
  );
  const skillsUserCatalog = useStore((s) => s.skillsUserCatalog);
  const skillsProjectCatalogByProjectPath = useStore((s) => s.skillsProjectCatalogByProjectPath);
  const capabilityPacks = useStore((s) => s.capabilityPacks);
  const fetchSkillsCatalog = useStore((s) => s.fetchSkillsCatalog);
  const fetchCapabilityPacks = useStore((s) => s.fetchCapabilityPacks);
  const isProvisioning = useStore((s) => isTeamProvisioningActive(s, teamName));
  const draft = useComposerDraft(draftKey ?? teamName);
  const seededInitialTextRef = useRef<string | null>(null);
  useEffect(() => {
    const text = initialText?.trim();
    if (!text || !draft.isLoaded || draft.text || seededInitialTextRef.current === text) return;
    seededInitialTextRef.current = text;
    draft.setText(text);
  }, [draft, initialText]);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );
  const leadProviderId = useMemo(() => {
    const lead = members.find((member) => isLeadMember(member));
    return (
      normalizeOptionalTeamProviderId(lead?.providerId) ?? inferTeamProviderIdFromModel(lead?.model)
    );
  }, [members]);

  useEffect(() => {
    void fetchSkillsCatalog(projectPath ?? undefined);
    void fetchCapabilityPacks();
  }, [fetchCapabilityPacks, fetchSkillsCatalog, projectPath]);

  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  const projectSkills = projectPath ? (skillsProjectCatalogByProjectPath[projectPath] ?? []) : [];
  const projectWorkflowSuggestions = useProjectWorkflowCommands(projectPath);
  const slashCommandSuggestions = useMemo<MentionSuggestion[]>(() => {
    const isBlockedCommand = (suggestion: MentionSuggestion) => {
      const raw = (suggestion.command ?? suggestion.name).trim().toLowerCase().replace(/^\//, '');
      return raw === 'loop' || raw === 'system' || raw.endsWith(':loop') || raw.endsWith(':system');
    };
    const localSuggestions = [
      ...projectWorkflowSuggestions,
      ...buildSlashCommandSuggestions(
        getSuggestedSlashCommandsForProvider(leadProviderId),
        projectSkills,
        skillsUserCatalog,
        leadProviderId
      ),
    ].filter((suggestion) => !isBlockedCommand(suggestion));
    const packSuggestions = buildCapabilityPackCommandSuggestions(capabilityPacks, 'team-loop', {
      forceNamespacedAliases: collectSlashSuggestionAliases(localSuggestions),
    }).filter((suggestion) => !isBlockedCommand(suggestion));
    return [...localSuggestions, ...packSuggestions];
  }, [
    capabilityPacks,
    leadProviderId,
    projectSkills,
    projectWorkflowSuggestions,
    skillsUserCatalog,
  ]);
  const capabilityRegistry = useMemo(
    () => buildSlashCommandRegistry({ packs: capabilityPacks, scope: 'team-loop' }),
    [capabilityPacks]
  );
  const shadowedAliases = useMemo(() => {
    const aliases = new Set(RESERVED_SLASH_COMMANDS);
    for (const alias of collectSlashSuggestionAliases(
      slashCommandSuggestions.filter((suggestion) => !suggestion.commandRef)
    )) {
      aliases.add(alias);
    }
    return aliases;
  }, [slashCommandSuggestions]);

  const trimmed = stripEncodedTaskReferenceMetadata(draft.text).trim();
  const standaloneSlashCommand = useMemo(() => parseStandaloneSlashCommand(trimmed), [trimmed]);
  const capabilityCommandResult = useMemo(
    () =>
      resolveCapabilityCommandInput(capabilityRegistry, trimmed, selectedCommand, {
        shadowedAliases,
      }),
    [capabilityRegistry, selectedCommand, shadowedAliases, trimmed]
  );

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const isLeadRecipient = selectedMember ? isLeadMember(selectedMember) : false;
  // NOTE: lead context ring disabled — usage formula is inaccurate
  // const isLeadAgentRecipient = selectedMember?.agentType === 'lead';
  // const leadContext = useStore((s) =>
  //   isLeadAgentRecipient ? s.leadContextByTeam[teamName] : undefined
  // );
  const supportsAttachments = isLeadRecipient && !!isTeamAlive;
  const canAttach = supportsAttachments && draft.canAddMore;
  const attachmentRestrictionReason = !supportsAttachments
    ? !isLeadRecipient
      ? '文件只能发送给 Lead'
      : 'Agent 在线时才能添加文件'
    : undefined;
  const attachmentsBlocked = draft.attachments.length > 0 && !supportsAttachments;
  const slashCommandRestrictionReason = standaloneSlashCommand
    ? capabilityCommandResult.status === 'conflict'
      ? (capabilityCommandResult.conflictLabel ??
        '能力包命令存在冲突，请从菜单选择带 namespace 的命令。')
      : draft.attachments.length > 0
        ? '斜杠命令需要 Lead 在线，且不能与附件同时发送'
        : !isLeadRecipient
          ? '斜杠命令只能发送给 Lead'
          : !isTeamAlive
            ? '斜杠命令需要 Lead 在线'
            : null
    : null;
  const canSendRegularMessage =
    recipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !isProvisioning &&
    !attachmentsBlocked &&
    !slashCommandRestrictionReason;
  const canSend = canSendRegularMessage;

  // Track whether we initiated a send — clear draft only on confirmed success
  const pendingSendRef = useRef(false);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    dismissMentionsRef.current?.();
    const taskRefs = extractTaskRefsFromText(draft.text, taskSuggestions);
    const serialized = serializeChipsWithText(trimmed, draft.chips);

    const send = async () => {
      if (capabilityCommandResult.status === 'resolved' && capabilityCommandResult.resolved) {
        const expanded = await expandCapabilityCommand(
          capabilityCommandResult.resolved,
          'team-loop'
        );
        pendingSendRef.current = true;
        onSend(
          recipient,
          expanded.text,
          expanded.summary,
          undefined,
          undefined,
          taskRefs,
          expanded.slashCommand
        );
        return;
      }

      pendingSendRef.current = true;
      onSend(
        recipient,
        serialized,
        trimmed,
        draft.attachments.length > 0 ? draft.attachments : undefined,
        undefined,
        taskRefs
      );
    };

    void send().catch((error: unknown) => {
      pendingSendRef.current = false;
      // Reuse the persisted draft; surface the error via console because this path is a local expansion failure
      // before the normal send error store is involved.
      console.error(error);
    });
  }, [canSend, capabilityCommandResult, recipient, trimmed, onSend, draft, taskSuggestions]);

  // Clear draft only after send completes successfully (sending: true → false, no error)
  useEffect(() => {
    if (!sending && pendingSendRef.current) {
      pendingSendRef.current = false;
      if (!sendError && sendDebugDetails?.delivered !== false) {
        draft.clearDraft();
      }
    }
  }, [sending, sendError, sendDebugDetails, draft]);

  const { addFiles: draftAddFiles } = draft;
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      if (input.files?.length) {
        void draftAddFiles(input.files);
      }
      input.value = '';
    },
    [draftAddFiles]
  );

  const showFileRestrictionError = useCallback(() => {
    setFileRestrictionError(attachmentRestrictionReason ?? '文件只能发送给 Lead');
    window.clearTimeout(fileRestrictionTimerRef.current);
    fileRestrictionTimerRef.current = window.setTimeout(() => {
      setFileRestrictionError(null);
    }, 4000);
  }, [attachmentRestrictionReason]);

  // Cleanup restriction error timer on unmount
  useEffect(() => {
    const ref = fileRestrictionTimerRef;
    return () => window.clearTimeout(ref.current);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const { handleDrop: draftHandleDrop } = draft;
  const handleDropWrapper = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!supportsAttachments) {
        const files = e.dataTransfer?.files;
        if (files?.length) {
          showFileRestrictionError();
        }
        return;
      }
      draftHandleDrop(e);
    },
    [supportsAttachments, draftHandleDrop, showFileRestrictionError]
  );

  const { handlePaste: draftHandlePaste } = draft;
  const handlePasteWrapper = useCallback(
    (e: React.ClipboardEvent) => {
      if (!supportsAttachments) {
        const hasFiles = Array.from(e.clipboardData.items).some((item) => item.kind === 'file');
        if (hasFiles) {
          e.preventDefault();
          showFileRestrictionError();
        }
        return;
      }
      draftHandlePaste(e);
    },
    [supportsAttachments, draftHandlePaste, showFileRestrictionError]
  );

  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const hasAttachmentPreviewContent =
    draft.attachments.length > 0 || Boolean(draft.attachmentError ?? fileRestrictionError);
  const shouldDockRecipientSelector = !hasAttachmentPreviewContent;
  const isCompactLayout = layout === 'compact';
  const compactFooterNotice = slashCommandRestrictionReason ? (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
      <AlertCircle size={10} className="shrink-0" />
      {slashCommandRestrictionReason}
    </span>
  ) : sendError ? (
    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
      <AlertCircle size={10} className="shrink-0" />
      {sendError}
    </span>
  ) : sendWarning ? (
    <OpenCodeDeliveryWarning warning={sendWarning} debugDetails={sendDebugDetails} />
  ) : lastResult?.deduplicated ? (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
      <Check size={10} className="shrink-0" />
      已复用最近一次跨团队请求
    </span>
  ) : null;

  return (
    <div
      className={cn('relative', isCompactLayout ? 'pb-1' : 'mb-1.5 pb-1.5')}
      role="group"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDropWrapper}
      onPaste={handlePasteWrapper}
    >
      <div
        className={cn(
          mailMode && 'hidden',
          shouldDockRecipientSelector ? 'mb-0' : 'mb-1',
          isCompactLayout ? 'space-y-1.5' : 'space-y-2'
        )}
      >
        <div className="flex items-center gap-2">
          {isLeadRecipient ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="*/*"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded p-1 transition-colors',
                      canAttach
                        ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] opacity-40'
                    )}
                    disabled={!canAttach}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {!isTeamAlive
                    ? 'Agent 在线时才能添加文件'
                    : !draft.canAddMore
                      ? '已达到附件上限'
                      : '添加文件（支持粘贴或拖拽）'}
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!isTeamAlive && !isProvisioning && (
              <span className="text-[10px]" style={{ color: 'var(--warning-text)' }}>
                Agent 离线
              </span>
            )}

            {/* Combined team + member selector */}
            <div
              className={cn(
                'mr-[15px] inline-flex items-center border text-xs transition-colors',
                shouldDockRecipientSelector
                  ? 'relative z-10 -mb-2 overflow-hidden rounded-b-none rounded-t-[1.35rem] border-b-0 bg-[var(--color-surface-raised)]'
                  : 'rounded-full',
                'border-[var(--color-border)]'
              )}
            >
              <Popover
                open={fixedRecipient ? false : recipientOpen}
                onOpenChange={fixedRecipient ? () => undefined : setRecipientOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={Boolean(fixedRecipient)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors',
                      shouldDockRecipientSelector
                        ? 'rounded-br-none rounded-tr-[1.35rem]'
                        : 'rounded-r-full',
                      'hover:bg-[var(--color-surface-raised)]'
                    )}
                  >
                    {recipient ? (
                      <MemberBadge
                        name={recipient}
                        color={selectedResolvedColor}
                        size="sm"
                        hideAvatar={recipient === 'user'}
                        disableHoverCard
                      />
                    ) : (
                      <span className="text-[var(--color-text-muted)]">选择...</span>
                    )}
                    {!fixedRecipient ? (
                      <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-56 p-1.5"
                  onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    setRecipientSearch('');
                    setTimeout(() => recipientSearchRef.current?.focus(), 0);
                  }}
                >
                  {members.length > 5 && (
                    <div className="relative mb-1">
                      <Search
                        size={12}
                        className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                      />
                      <input
                        ref={recipientSearchRef}
                        type="text"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-6 pr-2 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
                        placeholder="搜索..."
                        value={recipientSearch}
                        onChange={(e) => setRecipientSearch(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="max-h-48 space-y-0.5 overflow-y-auto">
                    {/* eslint-disable-next-line sonarjs/function-return-type -- IIFE rendering mixed elements/null */}
                    {(() => {
                      const query = recipientSearch.toLowerCase().trim();
                      const filtered = query
                        ? members.filter((m) => m.name.toLowerCase().includes(query))
                        : members;
                      if (filtered.length === 0) {
                        return (
                          <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">
                            无匹配结果
                          </div>
                        );
                      }
                      const sorted = [...filtered].sort((a, b) => {
                        const aIsLead = isLeadMember(a) ? 1 : 0;
                        const bIsLead = isLeadMember(b) ? 1 : 0;
                        return bIsLead - aIsLead;
                      });
                      return sorted.map((m) => {
                        const resolvedColor = colorMap.get(m.name);
                        const role = formatAgentRole(m.role) ?? formatAgentRole(m.agentType);
                        const isSelected = m.name === recipient;
                        return (
                          <button
                            key={m.name}
                            type="button"
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                              isSelected && 'bg-[var(--color-surface-raised)]'
                            )}
                            onClick={() => {
                              setRecipient(m.name);
                              setRecipientOpen(false);
                              setRecipientSearch('');
                            }}
                          >
                            <MemberBadge
                              name={m.name}
                              color={resolvedColor}
                              size="sm"
                              hideAvatar={m.name === 'user'}
                              disableHoverCard
                            />
                            {role ? (
                              <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                                {role}
                              </span>
                            ) : null}
                            {isSelected ? (
                              <Check size={12} className="ml-auto shrink-0 text-indigo-400" />
                            ) : null}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>

        {hasAttachmentPreviewContent ? (
          <AttachmentPreviewList
            attachments={draft.attachments}
            onRemove={draft.removeAttachment}
            error={draft.attachmentError ?? fileRestrictionError}
            onDismissError={draft.clearAttachmentError}
            disabled={attachmentsBlocked}
            disabledHint="仅在 Agent 在线且接收人为 Lead 时支持附件。请移除附件或切换接收人。"
          />
        ) : null}
      </div>

      <div className="relative">
        <DropZoneOverlay
          active={isDragOver}
          rejected={!supportsAttachments}
          rejectionReason={attachmentRestrictionReason}
        />
        <MentionableTextarea
          ref={textareaRef}
          id={`compose-${teamName}`}
          placeholder={
            isProvisioning
              ? 'Agent 正在启动中... 消息将在稍后发送。'
              : (placeholder ?? '输入指令...（回车发送，Shift+Enter 换行）')
          }
          value={draft.text}
          onValueChange={draft.setText}
          suggestions={mentionSuggestions}
          teamSuggestions={teamMentionSuggestions}
          taskSuggestions={taskSuggestions}
          commandSuggestions={slashCommandSuggestions}
          chips={draft.chips}
          onChipRemove={draft.removeChip}
          projectPath={projectPath}
          onFileChipInsert={draft.addChip}
          onModEnter={handleSend}
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
          dismissMentionsRef={dismissMentionsRef}
          extraTips={useMemo(() => {
            const commands = Array.from(
              new Set(
                slashCommandSuggestions
                  .filter((s) => s.type === 'command' && s.command)
                  .map((s) => s.command)
              )
            )
              .slice(0, 6)
              .join('、');
            return [`Tips：你可以输入 "/" 来运行命令，如 ${commands} 等。`];
          }, [slashCommandSuggestions])}
          surfaceClassName={
            mailMode
              ? 'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]'
              : 'message-composer-shell message-composer-orbit-surface bg-[var(--color-surface-raised)]'
          }
          surfaceDecoration={mailMode ? 'none' : 'orbit-border'}
          surfaceFadeColor={mailMode ? 'var(--color-surface)' : 'var(--color-surface-raised)'}
          className={cn(
            mailMode ? 'border-transparent px-1 shadow-none' : 'border-transparent shadow-none'
          )}
          minRows={minRows ?? (mailMode ? 4 : 1)}
          maxRows={maxRows ?? (mailMode ? 12 : 6)}
          maxLength={MAX_TEXT_LENGTH}
          disabled={sending}
          hintText={undefined}
          showHint={!isCompactLayout && !mailMode}
          cornerActionInset="compact"
          cornerAction={
            <div className="flex items-center gap-2">
              {/* NOTE: ContextRing disabled — usage formula is inaccurate */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center rounded-full p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]"
                    onClick={() => void api.openExternal('https://voicetext.site')}
                  >
                    <Mic size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">语音转文字</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canSend}
                      onClick={handleSend}
                    >
                      <Send size={12} />
                      {sendLabel}
                    </button>
                  </span>
                </TooltipTrigger>
                {slashCommandRestrictionReason ? (
                  <TooltipContent side="top">{slashCommandRestrictionReason}</TooltipContent>
                ) : isProvisioning && !sending ? (
                  <TooltipContent side="top">Agent 启动期间暂不可下发</TooltipContent>
                ) : null}
              </Tooltip>
            </div>
          }
          footerRight={
            isCompactLayout ? (
              compactFooterNotice
            ) : (
              <div className="flex items-center gap-2">
                {compactFooterNotice}
                {remaining < 200 ? (
                  <span
                    className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                  >
                    剩余 {remaining} 字符
                  </span>
                ) : null}
                {draft.isSaved ? (
                  <span className="text-[10px] text-[var(--color-text-muted)]">已保存</span>
                ) : null}
              </div>
            )
          }
        />
      </div>
    </div>
  );
};

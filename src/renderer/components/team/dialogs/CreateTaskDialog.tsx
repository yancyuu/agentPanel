import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { TiptapEditor } from '@renderer/components/ui/tiptap';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { chipToken, serializeChipsWithText } from '@renderer/types/inlineChip';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { AlertTriangle, ChevronDown, ChevronRight, Search } from 'lucide-react';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember, TaskRef, TeamTaskWithKanban } from '@shared/types';

interface CreateTaskDialogProps {
  open: boolean;
  teamName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  isTeamAlive?: boolean;
  defaultSubject?: string;
  defaultDescription?: string;
  defaultOwner?: string;
  defaultStartImmediately?: boolean;
  defaultChip?: InlineChip;
  onClose: () => void;
  onSubmit: (
    subject: string,
    description: string,
    owner?: string,
    blockedBy?: string[],
    related?: string[],
    prompt?: string,
    startImmediately?: boolean,
    descriptionTaskRefs?: TaskRef[],
    promptTaskRefs?: TaskRef[]
  ) => void;
  submitting?: boolean;
}

export const CreateTaskDialog = ({
  open,
  teamName,
  members,
  tasks,
  isTeamAlive = false,
  defaultSubject = '',
  defaultDescription = '',
  defaultOwner = '',
  defaultStartImmediately,
  defaultChip,
  onClose,
  onSubmit,
  submitting = false,
}: CreateTaskDialogProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const projectPath = useStore(
    (s) => selectTeamDataForName(s, teamName)?.config.projectPath ?? null
  );
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  const [subject, setSubject] = useState(defaultSubject);
  const descriptionDraft = useDraftPersistence({
    key: `createTask:${teamName}:description`,
    initialValue: defaultDescription || undefined,
  });
  const descChipDraft = useChipDraftPersistence(`createTask:${teamName}:descChips`);
  const [owner, setOwner] = useState<string>(defaultOwner);
  // 用户手动改动过负责人后，不再用成员列表自动覆盖（清空必须重新选择才能提交）
  const ownerTouchedRef = useRef(false);
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [related, setRelated] = useState<string[]>([]);
  const [startImmediately, setStartImmediately] = useState(false);
  const promptDraft = useDraftPersistence({ key: `createTask:${teamName}:prompt` });
  const [blockedBySearch, setBlockedBySearch] = useState('');
  const [relatedSearch, setRelatedSearch] = useState('');
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const prevOpenRef = useRef(false);

  // Reset form when dialog opens (avoid setState during render)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
      setSubject(defaultSubject);
      if (defaultChip) {
        const token = chipToken(defaultChip);
        descriptionDraft.setValue(token + '\n');
        descChipDraft.setChips([defaultChip]);
      } else if (defaultDescription) {
        descriptionDraft.setValue(defaultDescription);
        descChipDraft.clearChipDraft();
      } else {
        descriptionDraft.clearDraft();
        descChipDraft.clearChipDraft();
      }
      setOwner(defaultOwner || members[0]?.name || '');
      ownerTouchedRef.current = false;
      setBlockedBy([]);
      setRelated([]);
      setStartImmediately(defaultStartImmediately ?? false);
      promptDraft.clearDraft();
      setBlockedBySearch('');
      setRelatedSearch('');
      setShowOptionalFields(false);
    }
    prevOpenRef.current = open;
  }, [
    open,
    defaultSubject,
    defaultDescription,
    defaultOwner,
    defaultStartImmediately,
    defaultChip,
    isTeamAlive,
    members,
    descriptionDraft,
    descChipDraft,
    promptDraft,
  ]);

  // 成员列表晚于表单打开到达时补一次预填；用户手动改动过负责人则不再覆盖
  useEffect(() => {
    if (!open || owner || ownerTouchedRef.current || members.length === 0) return;
    setOwner(members[0].name);
  }, [open, owner, members]);

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

  // 负责人必选（团队即 agent 语义下预填团队自身；服务端虽有缺省兜底，表单层显式呈现）
  const canSubmit = subject.trim().length > 0 && !submitting && !!owner;

  // Only show non-internal, non-deleted tasks as candidates for blocking
  const availableTasks = tasks.filter(
    (t) => t.status !== 'deleted' && getTaskKanbanColumn(t) !== 'approved'
  );

  const toggleBlockedBy = (taskId: string): void => {
    setBlockedBy((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const toggleRelated = (taskId: string): void => {
    setRelated((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    const trimmedDescription = stripEncodedTaskReferenceMetadata(descriptionDraft.value.trim());
    const trimmedPrompt = stripEncodedTaskReferenceMetadata(promptDraft.value.trim());
    const serializedDesc = serializeChipsWithText(trimmedDescription, descChipDraft.chips);
    const descriptionTaskRefs = extractTaskRefsFromText(descriptionDraft.value, taskSuggestions);
    const promptTaskRefs = trimmedPrompt
      ? extractTaskRefsFromText(promptDraft.value, taskSuggestions)
      : [];
    onSubmit(
      subject.trim(),
      serializedDesc,
      owner || undefined,
      blockedBy.length > 0 ? blockedBy : undefined,
      related.length > 0 ? related : undefined,
      trimmedPrompt || undefined,
      isTeamAlive ? startImmediately : false,
      descriptionTaskRefs,
      promptTaskRefs
    );
    descriptionDraft.clearDraft();
    descChipDraft.clearChipDraft();
    promptDraft.clearDraft();
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      onClose();
    }
  };

  const assigneeField = (
    <div className="grid gap-2">
      <Label>负责人</Label>
      <MemberSelect
        members={members}
        value={owner || null}
        onChange={(v) => {
          ownerTouchedRef.current = true;
          setOwner(v ?? '');
        }}
        placeholder="选择成员"
      />
      {!owner ? <p className="text-[11px] text-amber-500">请选择负责人后再创建</p> : null}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[580px]">
        <DialogHeader>
          <DialogTitle>创建 Loop 任务</DialogTitle>
          <DialogDescription>
            任务会创建到 Loop workspace 的 tasks/ 目录，并显示在看板中。
          </DialogDescription>
        </DialogHeader>

        {!isTeamAlive ? (
          <div
            className="flex items-start gap-2 rounded-md border px-3 py-2"
            style={{
              backgroundColor: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">
              Loop runtime 当前未运行：没有本地 Claude/Agent 进程在运行。任务会加入{' '}
              <strong>待处理</strong>，启动 runtime 后即可进入循环。
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="task-subject">标题</Label>
            <Input
              id="task-subject"
              placeholder="需要完成什么？"
              value={subject}
              autoFocus
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) handleSubmit();
              }}
            />
          </div>

          {assigneeField}

          {/* Toggle button for optional fields */}
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            onClick={() => setShowOptionalFields((prev) => !prev)}
          >
            {showOptionalFields ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{showOptionalFields ? '隐藏可选项' : '显示可选项'}</span>
          </button>

          {/* Collapsible optional fields */}
          <div
            className="grid overflow-hidden transition-all duration-200 ease-in-out"
            style={{ gridTemplateRows: showOptionalFields ? '1fr' : '0fr' }}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label className="label-optional">描述（可选）</Label>
                  <TiptapEditor
                    content={descriptionDraft.value}
                    onChange={descriptionDraft.setValue}
                    placeholder="Loop 目标详情（支持 Markdown）"
                    minHeight="100px"
                    maxHeight="200px"
                    toolbar
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="task-prompt" className="label-optional">
                    给 Loop Lead 的执行指令（可选）
                  </Label>
                  <MentionableTextarea
                    id="task-prompt"
                    placeholder="给 Loop worker 的额外执行说明..."
                    value={promptDraft.value}
                    onValueChange={promptDraft.setValue}
                    suggestions={mentionSuggestions}
                    taskSuggestions={taskSuggestions}
                    projectPath={projectPath}
                    minRows={3}
                    maxRows={12}
                    footerRight={
                      promptDraft.isSaved ? (
                        <span className="text-[10px] text-[var(--color-text-muted)]">已保存</span>
                      ) : null
                    }
                  />
                </div>

                {availableTasks.length > 0 ? (
                  <div className="grid gap-2">
                    <Label className="label-optional">被这些任务阻塞（可选）</Label>
                    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {availableTasks.length > 3 ? (
                        <div className="relative border-b border-[var(--color-border)] px-2 py-1.5">
                          <Search
                            size={12}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                          />
                          <input
                            type="text"
                            placeholder="搜索任务..."
                            value={blockedBySearch}
                            onChange={(e) => setBlockedBySearch(e.target.value)}
                            className="w-full bg-transparent py-0.5 pl-5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : null}
                      <div className="max-h-[108px] overflow-y-auto p-1.5">
                        {availableTasks
                          .filter(
                            (t) =>
                              !blockedBySearch ||
                              t.subject.toLowerCase().includes(blockedBySearch.toLowerCase()) ||
                              t.id.includes(blockedBySearch) ||
                              t.displayId?.includes(blockedBySearch)
                          )
                          .map((t) => {
                            const isSelected = blockedBy.includes(t.id);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'bg-indigo-500/15 text-indigo-300'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                                }`}
                                onClick={() => toggleBlockedBy(t.id)}
                              >
                                <span
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                                    isSelected
                                      ? 'border-indigo-400 bg-indigo-500/30 text-indigo-300'
                                      : 'border-[var(--color-border-emphasis)]'
                                  }`}
                                >
                                  {isSelected ? '\u2713' : ''}
                                </span>
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1 py-0 text-[10px] font-normal"
                                >
                                  {formatTaskDisplayLabel(t)}
                                </Badge>
                                <span className="truncate">{t.subject}</span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                    {blockedBy.length > 0 ? (
                      <p className="text-[11px] text-yellow-300">
                        任务将被这些任务阻塞：{' '}
                        {blockedBy.map((id) => `#${deriveTaskDisplayId(id)}`).join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {availableTasks.length > 0 ? (
                  <div className="grid gap-2">
                    <Label className="label-optional">关联任务（可选）</Label>
                    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {availableTasks.length > 3 ? (
                        <div className="relative border-b border-[var(--color-border)] px-2 py-1.5">
                          <Search
                            size={12}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                          />
                          <input
                            type="text"
                            placeholder="搜索任务..."
                            value={relatedSearch}
                            onChange={(e) => setRelatedSearch(e.target.value)}
                            className="w-full bg-transparent py-0.5 pl-5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : null}
                      <div className="max-h-[108px] overflow-y-auto p-1.5">
                        {availableTasks
                          .filter(
                            (t) =>
                              !relatedSearch ||
                              t.subject.toLowerCase().includes(relatedSearch.toLowerCase()) ||
                              t.id.includes(relatedSearch) ||
                              t.displayId?.includes(relatedSearch)
                          )
                          .map((t) => {
                            const isSelected = related.includes(t.id);
                            return (
                              <button
                                key={`related:${t.id}`}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'bg-purple-500/15 text-purple-300'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                                }`}
                                onClick={() => toggleRelated(t.id)}
                              >
                                <span
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                                    isSelected
                                      ? 'border-purple-400 bg-purple-500/30 text-purple-300'
                                      : 'border-[var(--color-border-emphasis)]'
                                  }`}
                                >
                                  {isSelected ? '\u2713' : ''}
                                </span>
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1 py-0 text-[10px] font-normal"
                                >
                                  {formatTaskDisplayLabel(t)}
                                </Badge>
                                <span className="truncate">{t.subject}</span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                    {related.length > 0 ? (
                      <p className="text-[11px] text-purple-300">
                        已关联：{related.map((id) => `#${deriveTaskDisplayId(id)}`).join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {owner ? (
            <div className="grid gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="task-start-immediately"
                  checked={isTeamAlive ? startImmediately : false}
                  onCheckedChange={(v) => setStartImmediately(v === true)}
                  disabled={!isTeamAlive}
                />
                <Label
                  htmlFor="task-start-immediately"
                  className={`text-xs font-normal ${!isTeamAlive ? 'text-[var(--color-text-muted)]' : ''}`}
                >
                  立即开始
                </Label>
              </div>
              {!isTeamAlive ? (
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  Loop runtime 当前未运行。请先启动 runtime，才能立即开始循环。
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            size="sm"
            className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

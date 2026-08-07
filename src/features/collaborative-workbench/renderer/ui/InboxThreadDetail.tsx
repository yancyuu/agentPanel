import { useEffect, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MessageComposer } from '@renderer/components/team/messages/MessageComposer';
import { cn } from '@renderer/lib/utils';
import { ArrowLeft, Forward, Mail, Plus, Reply, X } from 'lucide-react';

import { stripInboxGoalDirective } from '../utils/inboxGoalDirective';

import type { InboxThreadsState } from '../hooks/useInboxThreads';
import type { InboxThreadProjection } from '../utils/inboxThreadProjection';
import type { InboxMessage } from '@shared/types';

interface InboxThreadDetailProps {
  thread: InboxThreadProjection | null;
  inbox: InboxThreadsState;
  onBack(): void;
  readOnly?: boolean;
  onCreateTask?(thread: InboxThreadProjection): void;
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface MailAction {
  messageKey: string;
  mode: 'reply' | 'forward';
}

function buildForwardBody(message: InboxMessage, subject: string): string {
  const sender = message.from === 'user' ? '我' : message.from;
  const body = message.from === 'user' ? stripInboxGoalDirective(message.text) : message.text;
  return [
    '',
    '---------- 转发邮件 ----------',
    `发件人：${sender}`,
    `时间：${formatMessageTime(message.timestamp)}`,
    `主题：${message.summary?.trim() || subject}`,
    '',
    body,
  ].join('\n');
}

export function InboxThreadDetail({
  thread,
  inbox,
  onBack,
  readOnly = false,
  onCreateTask,
}: Readonly<InboxThreadDetailProps>): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draftSubject, setDraftSubject] = useState('');
  const [mailAction, setMailAction] = useState<MailAction | null>(null);
  const [forwardRecipient, setForwardRecipient] = useState('');

  useEffect(() => {
    if (!thread) return;
    setDraftSubject('');
    setMailAction(null);
    setForwardRecipient(thread.participant);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
      if (thread.draft) textareaRef.current?.focus();
    });
  }, [thread]);

  if (!thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
        <Mail size={34} className="opacity-25" />
        <p className="text-sm">选择一条消息查看内容</p>
        <p className="text-xs opacity-70">数字员工发来的消息会集中显示在这里。</p>
      </div>
    );
  }

  const composerProps = {
    teamName: thread.teamName,
    members: inbox.members,
    fixedRecipient: thread.participant,
    draftKey: `inbox:${thread.key}`,
    initialText: thread.initialText,
    isTeamAlive: inbox.isTeamAlive,
    sending: inbox.sending,
    sendError: inbox.sendError,
    sendWarning: inbox.sendWarning,
    sendDebugDetails: inbox.sendDebugDetails,
    lastResult: inbox.lastResult,
    textareaRef,
  } as const;

  return (
    <div className="flex h-full min-h-0 flex-col bg-page-canvas">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--surface-border-subtle)] px-5 py-3.5">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] md:hidden"
          aria-label="返回私信列表"
        >
          <ArrowLeft size={15} />
        </button>
        <MemberBadge
          name={thread.participant}
          teamName={thread.teamName}
          size="md"
          disableHoverCard
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-[var(--color-text)]">
            {thread.draft ? '新私信' : thread.subject}
          </h2>
          <p className="truncate text-[11px] text-[var(--color-text-muted)]">
            {thread.draft
              ? `收件人 · ${thread.participant}`
              : `${thread.participant} · ${thread.messages.length} 条消息`}
          </p>
        </div>
        {readOnly && onCreateTask ? (
          <button
            type="button"
            onClick={() => onCreateTask(thread)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-indigo-600 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            <Plus size={13} />
            转为任务
          </button>
        ) : !thread.draft ? (
          <span className="hidden rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] sm:inline-flex">
            {thread.teamDisplayName}
          </span>
        ) : null}
      </header>

      {thread.draft ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5 lg:p-7">
          <section className="mx-auto w-full max-w-5xl">
            <div className="flex min-h-11 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
              <span className="w-14 shrink-0 text-xs text-[var(--color-text-muted)]">收件人</span>
              <MemberBadge
                name={thread.participant}
                teamName={thread.teamName}
                size="sm"
                disableHoverCard
              />
            </div>
            <label className="flex min-h-11 items-center gap-3 border-b border-[var(--color-border-subtle)] px-4">
              <span className="w-14 shrink-0 text-xs text-[var(--color-text-muted)]">主题</span>
              <input
                type="text"
                value={draftSubject}
                onChange={(event) => setDraftSubject(event.target.value)}
                placeholder="填写主题（可选）"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                maxLength={160}
              />
            </label>
            <div className="p-4">
              <MessageComposer
                {...composerProps}
                mailMode
                mailVariant="flat"
                minRows={10}
                maxRows={18}
                placeholder={`写给 ${thread.participant}…`}
                sendLabel="发送私信"
                onSend={(
                  recipient,
                  text,
                  summary,
                  attachments,
                  actionMode,
                  taskRefs,
                  slashCommand
                ) => {
                  void inbox.sendMessage(
                    recipient,
                    text,
                    draftSubject.trim() || summary,
                    attachments,
                    actionMode,
                    taskRefs,
                    slashCommand
                  );
                }}
              />
            </div>
          </section>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-7">
            <div className="mx-auto w-full max-w-5xl">
              {thread.messages.map((message, index) => {
                const fromUser = message.from === 'user';
                const messageKey = message.messageId ?? `${message.timestamp}:${index}`;
                return (
                  <article
                    key={messageKey}
                    className={cn(
                      'border-b border-[var(--color-border-subtle)] px-1 py-6',
                      index === 0 && 'border-t'
                    )}
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <MemberBadge
                        name={fromUser ? '我' : message.from}
                        teamName={thread.teamName}
                        size="xs"
                        hideAvatar={fromUser}
                        disableHoverCard
                      />
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                        {formatMessageTime(message.timestamp)}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--color-text-secondary)]">
                      {fromUser ? stripInboxGoalDirective(message.text) : message.text}
                    </div>
                    {message.attachments?.length ? (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {message.attachments.map((attachment) => (
                          <span
                            key={attachment.id}
                            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]"
                          >
                            {attachment.filename}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {!readOnly ? (
                      <div className="mt-4 flex items-center gap-1 border-t border-[var(--color-border-subtle)] pt-3">
                        <span className="mr-auto" />
                        <button
                          type="button"
                          onClick={() => setMailAction({ messageKey, mode: 'reply' })}
                          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                        >
                          <Reply size={13} />
                          回复
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setForwardRecipient(thread.participant);
                            setMailAction({ messageKey, mode: 'forward' });
                          }}
                          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                        >
                          <Forward size={13} />
                          转发
                        </button>
                      </div>
                    ) : null}
                    {!readOnly && mailAction?.messageKey === messageKey ? (
                      <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-4">
                        <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                          <span className="font-medium text-[var(--color-text-secondary)]">
                            {mailAction.mode === 'reply'
                              ? `回复 ${thread.participant}`
                              : '转发邮件'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setMailAction(null)}
                            className="ml-auto rounded p-1 hover:bg-[var(--color-surface-hover)]"
                            aria-label="关闭邮件编辑器"
                          >
                            <X size={13} />
                          </button>
                        </div>
                        {mailAction.mode === 'forward' ? (
                          <label className="mb-3 flex min-h-9 items-center gap-3 border-b border-[var(--color-border-subtle)] pb-3">
                            <span className="w-12 shrink-0 text-xs text-[var(--color-text-muted)]">
                              收件人
                            </span>
                            <select
                              value={forwardRecipient}
                              onChange={(event) => setForwardRecipient(event.target.value)}
                              aria-label="选择转发收件人"
                              className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] outline-none"
                            >
                              {inbox.members.map((member) => (
                                <option key={member.name} value={member.name}>
                                  {member.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <MessageComposer
                          {...composerProps}
                          fixedRecipient={
                            mailAction.mode === 'reply' ? thread.participant : forwardRecipient
                          }
                          draftKey={`inbox:${thread.key}:${messageKey}:${mailAction.mode}`}
                          initialText={
                            mailAction.mode === 'forward'
                              ? buildForwardBody(message, thread.subject)
                              : undefined
                          }
                          mailMode
                          mailVariant="flat"
                          minRows={4}
                          maxRows={10}
                          placeholder={mailAction.mode === 'reply' ? '写回复…' : '补充转发说明…'}
                          sendLabel={mailAction.mode === 'reply' ? '回复' : '转发'}
                          onSend={(...args) => {
                            if (mailAction.mode === 'reply') {
                              void inbox.sendMessage(...args);
                              return;
                            }
                            const [
                              recipient,
                              text,
                              ,
                              attachments,
                              actionMode,
                              taskRefs,
                              slashCommand,
                            ] = args;
                            void inbox.forwardMessage(
                              message.messageId,
                              thread.teamName,
                              recipient,
                              text,
                              `转发：${message.summary?.trim() || thread.subject}`,
                              attachments,
                              actionMode,
                              taskRefs,
                              slashCommand
                            );
                          }}
                        />
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

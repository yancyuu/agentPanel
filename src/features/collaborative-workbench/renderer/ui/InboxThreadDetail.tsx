import { useEffect, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MessageComposer } from '@renderer/components/team/messages/MessageComposer';
import { cn } from '@renderer/lib/utils';
import { ArrowLeft, Mail } from 'lucide-react';

import type { InboxThreadsState } from '../hooks/useInboxThreads';
import type { InboxThreadProjection } from '../utils/inboxThreadProjection';

interface InboxThreadDetailProps {
  thread: InboxThreadProjection | null;
  inbox: InboxThreadsState;
  onBack(): void;
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

export function InboxThreadDetail({
  thread,
  inbox,
  onBack,
}: Readonly<InboxThreadDetailProps>): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [draftSubject, setDraftSubject] = useState('');

  useEffect(() => {
    if (!thread) return;
    setDraftSubject('');
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
      if (thread.draft) textareaRef.current?.focus();
    });
  }, [thread]);

  if (!thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
        <Mail size={34} className="opacity-25" />
        <p className="text-sm">选择一封私信查看内容</p>
        <p className="text-xs opacity-70">数字员工的回复会持续归入同一封私信。</p>
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
              : `${thread.participant} · ${thread.messages.length} 封邮件`}
          </p>
        </div>
        {!thread.draft ? (
          <span className="hidden rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] sm:inline-flex">
            {thread.teamDisplayName}
          </span>
        ) : null}
      </header>

      {thread.draft ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5 lg:p-7">
          <section className="mx-auto w-full max-w-5xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
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
            <div className="mx-auto w-full max-w-5xl space-y-4">
              {thread.messages.map((message, index) => {
                const fromUser = message.from === 'user';
                const messageKey = message.messageId ?? `${message.timestamp}:${index}`;
                return (
                  <article
                    key={messageKey}
                    className={cn(
                      'rounded-xl border px-5 py-4 shadow-sm',
                      fromUser
                        ? 'border-indigo-500/20 bg-indigo-500/[0.05]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)]'
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
                    {message.summary && message.summary !== thread.subject ? (
                      <div className="mb-2 text-xs font-medium text-[var(--color-text)]">
                        {message.summary}
                      </div>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--color-text-secondary)]">
                      {message.text}
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
                  </article>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 border-t border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-5 pb-4 pt-4 lg:px-7">
            <div className="mx-auto w-full max-w-5xl">
              <div className="mb-2 text-xs text-[var(--color-text-muted)]">
                回复给{' '}
                <span className="font-medium text-[var(--color-text-secondary)]">
                  {thread.participant}
                </span>
              </div>
              <MessageComposer
                {...composerProps}
                mailMode
                minRows={3}
                maxRows={10}
                placeholder="写回复…"
                sendLabel="回复"
                onSend={(...args) => {
                  void inbox.sendMessage(...args);
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

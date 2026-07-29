import { useEffect, useRef } from 'react';

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

  useEffect(() => {
    if (!thread) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
      if (thread.draft) textareaRef.current?.focus();
    });
  }, [thread]);

  if (!thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
        <Mail size={34} className="opacity-25" />
        <p className="text-sm">选择一封邮件开始对话</p>
        <p className="text-xs opacity-70">员工回复会持续归入同一封邮件。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-page-canvas">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--surface-border-subtle)] px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] md:hidden"
          aria-label="返回邮件列表"
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
          <h2 className="truncate text-sm font-medium text-[var(--color-text)]">
            {thread.subject}
          </h2>
          <p className="truncate text-[11px] text-[var(--color-text-muted)]">
            {thread.teamDisplayName} · 与 {thread.participant} 的对话
          </p>
        </div>
        <span className="hidden rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] sm:inline-flex">
          {thread.messages.length} 封往来
        </span>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {thread.messages.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-6 py-10 text-center text-[var(--color-text-muted)]">
            <Mail size={28} className="opacity-35" />
            <p className="text-sm text-[var(--color-text-secondary)]">新建对话邮件</p>
            <p className="text-xs">写下第一封邮件，{thread.participant} 的回复会继续显示在这里。</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            {thread.messages.map((message, index) => {
              const fromUser = message.from === 'user';
              const messageKey = message.messageId ?? `${message.timestamp}:${index}`;
              return (
                <article
                  key={messageKey}
                  className={cn(
                    'rounded-lg border px-4 py-3',
                    fromUser
                      ? 'ml-8 border-indigo-500/20 bg-indigo-500/[0.06]'
                      : 'mr-8 border-[var(--color-border)] bg-[var(--color-surface-raised)]'
                  )}
                >
                  <div className="mb-2 flex items-center gap-2">
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
                  {message.summary ? (
                    <div className="mb-1 text-xs font-medium text-[var(--color-text)]">
                      {message.summary}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]">
                    {message.text}
                  </div>
                  {message.attachments?.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {message.attachments.map((attachment) => (
                        <span
                          key={attachment.id}
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]"
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
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--surface-border-subtle)] bg-[var(--color-surface)] px-4 pb-3 pt-3">
        <div className="mx-auto max-w-3xl">
          <MessageComposer
            key={thread.key}
            teamName={thread.teamName}
            members={inbox.members}
            fixedRecipient={thread.participant}
            draftKey={`inbox:${thread.key}`}
            placeholder={`回复 ${thread.participant}…（回车发送，Shift+Enter 换行）`}
            sendLabel="发送"
            initialText={thread.initialText}
            isTeamAlive={inbox.isTeamAlive}
            sending={inbox.sending}
            sendError={inbox.sendError}
            sendWarning={inbox.sendWarning}
            sendDebugDetails={inbox.sendDebugDetails}
            lastResult={inbox.lastResult}
            textareaRef={textareaRef}
            onSend={(...args) => {
              void inbox.sendMessage(...args);
            }}
          />
        </div>
      </div>
    </div>
  );
}

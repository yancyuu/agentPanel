import { useEffect, useMemo, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { selectTeamMessages } from '@renderer/store/slices/teamSlice';
import { Send } from 'lucide-react';

import type { ResolvedTeamMember } from '@shared/types';

interface AgentTuningDialogProps {
  open: boolean;
  teamName: string;
  member: ResolvedTeamMember | null;
  onClose(): void;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

const REPLY_TIMEOUT_MS = 90_000;

export const AgentTuningDialog = ({
  open,
  teamName,
  member,
  onClose,
}: Readonly<AgentTuningDialogProps>): React.JSX.Element | null => {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendTeamMessage = useStore((state) => state.sendTeamMessage);
  const sending = useStore((state) => state.sendingMessage);
  const sendError = useStore((state) => state.sendMessageError);
  const allMessages = useStore((state) => selectTeamMessages(state, teamName));
  const conversationId = member ? `tuning:${teamName}:${member.name}` : '';
  // selectTeamMessages 返回最新在前，这里反转为时间正序：渲染自上而下、
  // 末尾即最新消息，typing 判定才成立。
  const messages = useMemo(
    () => allMessages.filter((message) => message.conversationId === conversationId).reverse(),
    [allMessages, conversationId]
  );

  // 最后一条是我发的 → agent 尚未回复（流式回复落进 messages 后自动解除）
  const lastMessage = messages[messages.length - 1];
  const awaitingReply = Boolean(lastMessage && lastMessage.from === 'user');
  const [replyTimedOut, setReplyTimedOut] = useState(false);
  useEffect(() => {
    setReplyTimedOut(false);
    if (!open || !awaitingReply || sending) return;
    const timer = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [open, awaitingReply, sending, lastMessage?.messageId]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' });
    });
  }, [messages.length, open]);

  if (!member) return null;

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    await sendTeamMessage(teamName, {
      member: member.name,
      text: body,
      summary: body,
      conversationId,
      replyToConversationId: conversationId,
      sessionKey: `${teamName}:member:${member.name}`,
      to: member.name,
      source: 'user_sent',
    });
    setText('');
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="flex max-h-[85vh] min-h-[560px] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MemberBadge name={member.name} teamName={teamName} size="sm" disableHoverCard />
            调教 {member.name}
          </DialogTitle>
          <DialogDescription>
            直接告诉它哪里需要调整。这里的对话只用于改变做事方式，不会创建任务。
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto border-y border-[var(--color-border-subtle)] py-2"
        >
          {messages.length > 0 && (sending || awaitingReply) ? (
            <div
              className="border-b border-[var(--color-border-subtle)] px-1 py-3"
              data-testid="tuning-typing"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text-secondary)]">
                  {member.name}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <span className="inline-flex gap-1" aria-hidden>
                  <span className="size-1.5 animate-pulse rounded-full bg-indigo-400" />
                  <span className="size-1.5 animate-pulse rounded-full bg-indigo-400 [animation-delay:150ms]" />
                  <span className="size-1.5 animate-pulse rounded-full bg-indigo-400 [animation-delay:300ms]" />
                </span>
                {sending ? '正在发送…' : '正在输入…'}
              </div>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="flex h-full min-h-64 flex-col items-center justify-center px-8 text-center text-[var(--color-text-muted)]">
              {sending ? (
                <p className="text-sm" data-testid="tuning-sending-empty">
                  正在发送…
                </p>
              ) : null}
              <p className="text-sm">告诉它你希望怎么改</p>
              <p className="mt-1 text-xs leading-5 opacity-75">
                例如：“回答再简短一点”“先给结论，再解释原因”“以后不要主动修改文件”。
              </p>
            </div>
          ) : (
            messages.map((message, index) => {
              const fromUser = message.from === 'user';
              return (
                <div
                  key={message.messageId ?? `${message.timestamp}:${index}`}
                  className="border-b border-[var(--color-border-subtle)] px-1 py-4 last:border-b-0"
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="font-medium text-[var(--color-text-secondary)]">
                      {fromUser ? '我' : message.from}
                    </span>
                    <span>{formatTime(message.timestamp)}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--color-text-secondary)]">
                    {message.text}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="pt-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              void send();
            }}
            placeholder={`告诉 ${member.name} 需要怎么调整…`}
            className="min-h-28 w-full resize-none bg-transparent text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            maxLength={20_000}
            autoFocus
          />
          {sendError ? <p className="mb-2 text-xs text-red-500">{sendError}</p> : null}
          {replyTimedOut ? (
            <p className="mb-2 text-xs text-amber-500" data-testid="tuning-reply-timeout">
              等待回复超时：{member.name} 可能未在运行，可到「运行时」设置检查后再试。
            </p>
          ) : null}
          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3">
            <span className="text-[11px] text-[var(--color-text-muted)]">
              Enter 发送，Shift + Enter 换行
            </span>
            <button
              type="button"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-indigo-600 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={13} />
              {sending ? '正在发送…' : awaitingReply ? '等待回复…' : '发送'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

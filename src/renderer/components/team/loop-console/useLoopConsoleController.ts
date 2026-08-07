import { useCallback, useState } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import type { LoopSendIntent } from './loopSendIntent';
import type { DiscoverableWorker, InboxMessage } from '@shared/types';

interface UseLoopConsoleControllerOptions {
  teamName: string;
  sessionKey?: string | null;
  sessionPendingRecipient?: string;
  onPendingReplyChange: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
}

interface UseLoopConsoleControllerResult {
  sending: boolean;
  statusMessage: string | null;
  submitIntent: (intent: LoopSendIntent) => Promise<boolean>;
}

function currentIso(): string {
  return new Date().toISOString();
}

function buildOptimisticSystemMessage(text: string, to: string = 'user'): InboxMessage {
  return {
    from: 'system',
    to,
    text,
    timestamp: currentIso(),
    read: true,
    messageId: `loop-console-${Date.now().toString(36)}`,
    source: 'system_notification',
  };
}

function normalizeSessionKey(sessionKey?: string | null): string | undefined {
  return sessionKey && sessionKey !== '__unassigned__' ? sessionKey : undefined;
}

function formatWorkersList(workers: DiscoverableWorker[]): string {
  if (!workers.length) return '当前没有可用数字员工。';
  const lines = workers.map((worker) => {
    const status = worker.status === 'online' ? 'online' : 'offline';
    const workDir = worker.workDir ? ` · ${worker.workDir}` : '';
    const harness = worker.harness ? ` · ${worker.harness}` : '';
    const description = worker.description ? ` — ${worker.description}` : '';
    return `- @${worker.workerId} ${worker.name} · ${status}${workDir}${harness}${description}`;
  });
  return [
    '当前数字员工：',
    ...lines,
    '',
    '在指令台输入 `@workerId 任务内容` 可直接调用对应员工。',
  ].join('\n');
}

export function useLoopConsoleController({
  teamName,
  sessionKey,
  sessionPendingRecipient,
  onPendingReplyChange,
}: UseLoopConsoleControllerOptions): UseLoopConsoleControllerResult {
  const [localSending, setLocalSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { sendTeamMessage, addOptimisticTeamMessage, refreshTeamMessagesHead, sendingMessage } =
    useStore(
      useShallow((s) => ({
        sendTeamMessage: s.sendTeamMessage,
        addOptimisticTeamMessage: s.addOptimisticTeamMessage,
        refreshTeamMessagesHead: s.refreshTeamMessagesHead,
        sendingMessage: s.sendingMessage,
      }))
    );

  const submitIntent = useCallback(
    async (intent: LoopSendIntent): Promise<boolean> => {
      const routedSessionKey = normalizeSessionKey(sessionKey);
      setStatusMessage(null);

      if (intent.kind === 'message') {
        const sentAtMs = Date.now();
        onPendingReplyChange((prev) => ({ ...prev, [intent.recipient]: sentAtMs }));
        try {
          const result = await sendTeamMessage(teamName, {
            member: intent.recipient,
            text: intent.text,
            summary: intent.summary,
            attachments: intent.attachments,
            taskRefs: intent.taskRefs,
            slashCommand: intent.slashCommand,
            sessionKey: routedSessionKey,
          });
          if (
            result.runtimeDelivery?.attempted === true &&
            result.runtimeDelivery.delivered === false
          ) {
            onPendingReplyChange((prev) => {
              if (prev[intent.recipient] !== sentAtMs) return prev;
              const next = { ...prev };
              delete next[intent.recipient];
              return next;
            });
          }
          return true;
        } catch (error) {
          onPendingReplyChange((prev) => {
            if (prev[intent.recipient] !== sentAtMs) return prev;
            const next = { ...prev };
            delete next[intent.recipient];
            return next;
          });
          setStatusMessage(error instanceof Error ? error.message : '指令发送失败');
          return false;
        }
      }

      if (intent.kind === 'workers-list') {
        setLocalSending(true);
        try {
          const result = await api.workers.list();
          addOptimisticTeamMessage(
            teamName,
            buildOptimisticSystemMessage(formatWorkersList(result.workers))
          );
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : '获取数字员工列表失败';
          setStatusMessage(message);
          addOptimisticTeamMessage(teamName, buildOptimisticSystemMessage(message));
          return false;
        } finally {
          setLocalSending(false);
        }
      }

      setLocalSending(true);
      const sentAtMs = Date.now();
      const pendingRecipient = sessionPendingRecipient ?? teamName;
      try {
        if (intent.kind === 'runtime') {
          await api.teams.processSend(teamName, intent.text);
          addOptimisticTeamMessage(
            teamName,
            buildOptimisticSystemMessage(
              `已注入 runtime（不写入消息看板）：${intent.summary ?? intent.text}`
            )
          );
          return true;
        }

        onPendingReplyChange((prev) => ({ ...prev, [pendingRecipient]: sentAtMs }));
        const response = await api.teams.createLoopSession(teamName, {
          sessionName: intent.sessionName,
          message: intent.text,
          reuse: intent.reuse,
        });
        const verb = response.reused ? '已复用' : '已创建';
        addOptimisticTeamMessage(
          teamName,
          buildOptimisticSystemMessage(
            `${verb}本地会话「${response.session.title || response.session.sessionKey}」并下发初始指令，正在等待 Claude 回复。`,
            'cc'
          )
        );
        await refreshTeamMessagesHead(teamName).catch(() => undefined);
        return true;
      } catch (error) {
        onPendingReplyChange((prev) => {
          if (prev[pendingRecipient] !== sentAtMs) return prev;
          const next = { ...prev };
          delete next[pendingRecipient];
          return next;
        });
        const message = error instanceof Error ? error.message : 'Loop runtime 操作失败';
        setStatusMessage(message);
        addOptimisticTeamMessage(teamName, buildOptimisticSystemMessage(message));
        return false;
      } finally {
        setLocalSending(false);
      }
    },
    [
      addOptimisticTeamMessage,
      onPendingReplyChange,
      refreshTeamMessagesHead,
      sendTeamMessage,
      sessionKey,
      sessionPendingRecipient,
      teamName,
    ]
  );

  return {
    sending: localSending || sendingMessage,
    statusMessage,
    submitIntent,
  };
}

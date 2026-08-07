/**
 * CcSessionsSection — 显示 cc-connect 会话列表。
 * 直接消费 /api/teams/:name/sessions 返回的 CcSession 结构，
 * 不依赖旧 Electron 项目系统。
 *
 * 改进：
 * - 分组：live 会话在上，inactive 在下
 * - 运行中和历史会话统一展示在团队详情中
 * - 点击会话行可展开最近历史动态
 */

import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Monitor,
  Radio,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

import type { CcSession, CcSessionDetail } from '@shared/types';

const SESSION_DETAIL_PAGE_SIZE = 6;
const HISTORICAL_SESSION_PAGE_SIZE = 3;

function formatSessionDetailError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/session not found/i.test(message)) {
    return '会话文件已不存在，请刷新会话列表';
  }
  return message || '加载会话历史失败';
}

interface CcSessionsSectionProps {
  teamName: string;
  sessions: CcSession[];
  loading: boolean;
  error: string | null;
}

export const CcSessionsSection = ({
  teamName,
  sessions,
  loading,
  error,
}: CcSessionsSectionProps): React.JSX.Element => {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [visibleHistoricalCount, setVisibleHistoricalCount] = useState(
    HISTORICAL_SESSION_PAGE_SIZE
  );

  useEffect(() => {
    setExpandedSessionId((current) =>
      current && sessions.some((session) => session.id === current) ? current : null
    );
  }, [sessions]);

  useEffect(() => {
    setVisibleHistoricalCount(HISTORICAL_SESSION_PAGE_SIZE);
  }, [teamName]);

  const toggleExpandedSession = useCallback((sessionId: string) => {
    setExpandedSessionId((current) => (current === sessionId ? null : sessionId));
  }, []);

  const loadMoreHistoricalSessions = useCallback(() => {
    setVisibleHistoricalCount((current) => current + HISTORICAL_SESSION_PAGE_SIZE);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        正在加载会话...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        <Monitor size={20} className="mx-auto mb-2 opacity-40" />
        暂无会话
      </div>
    );
  }

  const allSorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const liveSessions = allSorted.filter((s) => s.live);
  const inactiveSessions = allSorted.filter((s) => !s.live);
  const visibleInactiveSessions = inactiveSessions.slice(0, visibleHistoricalCount);
  const hiddenHistoricalCount = Math.max(
    inactiveSessions.length - visibleInactiveSessions.length,
    0
  );
  return (
    <div className="space-y-1">
      {liveSessions.length > 0 && (
        <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-400/70">
          运行中 ({liveSessions.length})
        </div>
      )}
      {liveSessions.map((s) => (
        <CcSessionRow
          key={s.id}
          teamName={teamName}
          session={s}
          isExpanded={expandedSessionId === s.id}
          onToggleExpanded={toggleExpandedSession}
        />
      ))}

      {inactiveSessions.length > 0 && (
        <div className="flex items-center justify-between px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          <span>历史 ({inactiveSessions.length})</span>
          {hiddenHistoricalCount > 0 && <span>已显示 {visibleInactiveSessions.length}</span>}
        </div>
      )}
      {visibleInactiveSessions.map((s) => (
        <CcSessionRow
          key={s.id}
          teamName={teamName}
          session={s}
          isExpanded={expandedSessionId === s.id}
          onToggleExpanded={toggleExpandedSession}
        />
      ))}
      {hiddenHistoricalCount > 0 && (
        <button
          type="button"
          className="mx-auto mt-2 flex items-center justify-center rounded-full bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          onClick={loadMoreHistoricalSessions}
        >
          加载更多历史会话 ({hiddenHistoricalCount})
        </button>
      )}
    </div>
  );
};

export function isExportPayload(
  value: unknown
): value is { filename: string; mimeType: string; content: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.filename === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.content === 'string'
  );
}

export function hasDataRows(csv: string): boolean {
  return (
    csv
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length > 1
  );
}

export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob(['\ufeff' + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function buildAllSessionsCsv(
  rows: { session: CcSession; detail: CcSessionDetail | null }[]
): string {
  const headers = [
    'sessionId',
    'sessionName',
    'sessionKey',
    'platform',
    'userName',
    'chatName',
    'messageRole',
    'messageTimestamp',
    'messageContent',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'totalTokens',
  ];
  const lines = [headers.map(csvEscape).join(',')];

  for (const { session, detail } of rows) {
    const messages = detail?.history?.length
      ? detail.history
      : session.lastMessage
        ? [session.lastMessage]
        : [];
    const sessionName = session.chatName || session.userName || session.title || session.sessionKey;
    for (const message of messages) {
      lines.push(
        [
          session.id,
          sessionName,
          session.sessionKey,
          session.platform,
          session.userName,
          session.chatName,
          message.role,
          message.timestamp,
          message.content,
          '',
          '',
          '',
          '',
          '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildAllSessionsCsvFilename(teamName: string): string {
  return `${sanitizeFilename(teamName)}-all-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
}

function csvEscape(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const CcSessionRow = ({
  teamName,
  session,
  isExpanded,
  onToggleExpanded,
}: {
  teamName: string;
  session: CcSession;
  isExpanded: boolean;
  onToggleExpanded: (sessionId: string) => void;
}): React.JSX.Element => {
  const timeAgo = formatShortTime(new Date(session.updatedAt));
  const label = session.chatName || session.userName || session.title || session.sessionKey;
  const platformLabel = session.platform === 'bridge' ? 'Bridge' : session.platform;
  const [detail, setDetail] = useState<CcSessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(SESSION_DETAIL_PAGE_SIZE);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const hasMoreHistory =
    detail != null &&
    Array.isArray(detail.history) &&
    detail.history.length < Math.max(detail.historyCount ?? 0, detail.history.length);

  useEffect(() => {
    if (!isExpanded) {
      setDetail(null);
      setDetailError(null);
      setLoadingDetail(false);
      setLoadingMoreHistory(false);
      setHistoryLimit(SESSION_DETAIL_PAGE_SIZE);
      return;
    }

    let cancelled = false;
    const isIncrementalLoad = historyLimit > SESSION_DETAIL_PAGE_SIZE;
    setDetailError(null);
    setLoadingDetail(true);
    setLoadingMoreHistory(isIncrementalLoad);
    void api.teams
      .getSessionDetail(teamName, session.id, historyLimit)
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(formatSessionDetailError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
          setLoadingMoreHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [historyLimit, isExpanded, session.hasLocalFile, session.id, teamName]);

  const handleLoadMoreHistory = useCallback(() => {
    if (loadingDetail || loadingMoreHistory || !hasMoreHistory) {
      return;
    }
    setHistoryLimit((prev) => prev + SESSION_DETAIL_PAGE_SIZE);
  }, [hasMoreHistory, loadingDetail, loadingMoreHistory]);

  return (
    <div
      className={`group relative rounded-xl border transition-colors ${
        isExpanded
          ? 'border-indigo-500/20 bg-indigo-500/[0.04]'
          : session.live
            ? 'border-emerald-500/20 bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08]'
            : 'border-transparent bg-[var(--color-surface)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-raised)]'
      }`}
    >
      <button
        type="button"
        className="group relative flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left text-xs"
        onClick={() => onToggleExpanded(session.id)}
        aria-expanded={isExpanded}
      >
        <div className="mt-0.5 shrink-0 rounded-full p-0.5 text-[var(--color-text-muted)] transition-colors group-hover:bg-[var(--color-surface-raised)] group-hover:text-[var(--color-text)]">
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>

        <div className="mt-0.5 shrink-0">
          {session.live ? (
            <Radio size={12} className="animate-pulse text-emerald-400" />
          ) : session.active ? (
            <Wifi size={12} className="text-indigo-400" />
          ) : (
            <WifiOff size={12} className="text-[var(--color-text-muted)] opacity-50" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {session.live && (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
            )}
            <span className="truncate font-medium text-[var(--color-text)]">{label}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            <span className="rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5">
              {platformLabel}
            </span>
            <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0.5">
              <MessageSquare size={9} />
              {session.historyCount}
            </span>
            <span className="tabular-nums">{timeAgo}</span>
            {session.live && <span className="text-emerald-500 dark:text-emerald-400">进行中</span>}
          </div>

          {session.lastMessage && (
            <p className="mt-1.5 truncate text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              <span
                className={
                  session.lastMessage.role === 'user'
                    ? 'text-indigo-400'
                    : 'text-[var(--color-text-muted)]'
                }
              >
                {session.lastMessage.role === 'user' ? '用户' : 'Agent'}：
              </span>
              {session.lastMessage.content.slice(0, 96)}
              {session.lastMessage.content.length > 96 ? '…' : ''}
            </p>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          {loadingDetail && !detail && (
            <div className="rounded-lg bg-[var(--color-surface)] p-3">
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-3 animate-pulse rounded bg-[var(--color-surface-raised)]"
                  />
                ))}
              </div>
            </div>
          )}
          {detailError && !loadingDetail && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle size={13} className="shrink-0" />
              <span>{detailError}</span>
            </div>
          )}
          {detail && (
            <div className="rounded-lg bg-[var(--color-surface)] p-2">
              {detail.history.length === 0 ? (
                <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">暂无动态</div>
              ) : (
                <>
                  <div className="mb-2 flex items-center justify-between px-1 text-[10px] text-[var(--color-text-muted)]">
                    <span>会话历史</span>
                    <span>
                      已显示 {detail.history.length} / {detail.historyCount}
                    </span>
                  </div>
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {[...detail.history].reverse().map((msg, i) => {
                      const isUserMessage = msg.role === 'user';
                      return (
                        <div
                          key={`${msg.timestamp}-${i}`}
                          className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
                            isUserMessage
                              ? 'bg-indigo-500/10 text-[var(--color-text)]'
                              : 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                          }`}
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <span
                              className={`shrink-0 text-[10px] font-medium ${
                                isUserMessage ? 'text-indigo-400' : 'text-[var(--color-text-muted)]'
                              }`}
                            >
                              {isUserMessage ? '用户' : 'Agent'}
                            </span>
                            <span className="text-[10px] text-[var(--color-text-muted)] opacity-60">
                              {formatMessageTime(msg.timestamp)}
                            </span>
                          </div>
                          <div className="whitespace-pre-wrap break-words">
                            {msg.content.slice(0, 500)}
                            {msg.content.length > 500 ? '…' : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {hasMoreHistory && (
                    <div className="mt-2 flex items-center justify-between gap-2 px-1">
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        每次加载 {SESSION_DETAIL_PAGE_SIZE} 条
                      </span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={handleLoadMoreHistory}
                        disabled={loadingDetail || loadingMoreHistory}
                      >
                        {loadingMoreHistory ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            加载中...
                          </>
                        ) : (
                          <>加载更早 ({Math.max(detail.historyCount - detail.history.length, 0)})</>
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function buildSessionRecordMarkdown(session: CcSession, detail: CcSessionDetail): string {
  const title = session.chatName || session.userName || session.title || session.sessionKey;
  const lines = [
    `# ${title}`,
    '',
    `- Team: ${detail.name || session.projectId}`,
    `- Session key: ${detail.sessionKey || session.sessionKey}`,
    `- Platform: ${detail.platform || session.platform}`,
    `- Status: ${detail.live ? 'live' : detail.active ? 'active' : 'inactive'}`,
    `- Created: ${detail.createdAt || session.createdAt}`,
    `- Updated: ${detail.updatedAt || session.updatedAt}`,
    `- Loop events: ${detail.historyCount}`,
    '',
    '## Loop events',
    '',
  ];

  if (detail.history.length === 0) {
    lines.push('_No Loop events._', '');
    return lines.join('\n');
  }

  for (const msg of [...detail.history].reverse()) {
    lines.push(
      `### ${msg.role === 'user' ? 'User' : 'Agent'} · ${msg.timestamp}`,
      '',
      msg.content,
      ''
    );
  }

  return lines.join('\n');
}

function buildSessionRecordFilename(teamName: string, session: CcSession): string {
  const updatedAt = session.updatedAt.replace(/[:.]/g, '-');
  return `${sanitizeFilename(teamName)}-${sanitizeFilename(session.sessionKey)}-${updatedAt}.md`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function formatShortTime(date: Date): string {
  try {
    const distance = formatDistanceToNowStrict(date, { addSuffix: false });
    return distance
      .replace(' seconds', 's')
      .replace(' second', 's')
      .replace(' minutes', 'm')
      .replace(' minute', 'm')
      .replace(' hours', 'h')
      .replace(' hour', 'h')
      .replace(' days', 'd')
      .replace(' day', 'd')
      .replace(' weeks', 'w')
      .replace(' week', 'w')
      .replace(' months', 'mo')
      .replace(' month', 'mo')
      .replace(' years', 'y')
      .replace(' year', 'y');
  } catch {
    return '';
  }
}

function formatMessageTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m 前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h 前`;
    return `${Math.floor(diffSec / 86400)}d 前`;
  } catch {
    return '';
  }
}

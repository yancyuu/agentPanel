import { useEffect, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { extractRecentToolActivity, type LeadToolActivity } from '@renderer/utils/leadToolActivity';
import { resolveProjectIdByPath } from '@renderer/utils/projectLookup';
import { useShallow } from 'zustand/react/shallow';

const POLL_INTERVAL_MS = 10_000;

export interface UseLeadSessionToolActivityOptions {
  teamName: string;
  /** Lead/loop session id to surface tool activity for. */
  sessionId?: string | null;
  /** Workspace path used to resolve the project id that owns the session file. */
  projectPath?: string | null;
  /** When false, the session is treated as offline and polling pauses. */
  isAlive?: boolean;
  /** Max number of recent tool calls to return (newest first). */
  limit?: number;
}

/**
 * Surface the lead agent's recent tool calls (Bash/Read/Edit/…) for the Loop
 * console. Tool activity lives in the parsed session detail, not the team
 * message feed, so this fetches the lead session (idempotently, into a
 * loop-console-scoped tab slot) and polls while the team is alive.
 *
 * Works for both the team Loop console (TeamDetailView) and the admin Loop
 * console (SystemManagerView) since it only needs teamName + a session id +
 * the workspace path.
 */
export function useLeadSessionToolActivity({
  teamName,
  sessionId,
  projectPath,
  isAlive,
  limit = 8,
}: UseLeadSessionToolActivityOptions): LeadToolActivity[] {
  const tabId = `loop-tools:${teamName}`;

  const { projects, repositoryGroups, fetchSessionDetail, sessionDetail } = useStore(
    useShallow((s) => ({
      projects: s.projects,
      repositoryGroups: s.repositoryGroups,
      fetchSessionDetail: s.fetchSessionDetail,
      sessionDetail: tabId ? (s.tabSessionData[tabId]?.sessionDetail ?? null) : null,
    }))
  );

  const projectId = useMemo(
    () => resolveProjectIdByPath(projectPath ?? null, projects, repositoryGroups),
    [projectPath, projects, repositoryGroups]
  );

  useEffect(() => {
    if (!projectId || !sessionId) return;
    void fetchSessionDetail(projectId, sessionId, tabId, { silent: true });
    if (!isAlive) return undefined;
    const handle = window.setInterval(() => {
      void fetchSessionDetail(projectId, sessionId, tabId, { silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [fetchSessionDetail, isAlive, projectId, sessionId, tabId]);

  // Only use the detail when it actually matches the requested session, so a
  // stale detail from a previous session never leaks into the timeline.
  const matchedDetail =
    sessionId && sessionDetail?.session?.id === sessionId ? sessionDetail : null;

  return useMemo(
    () => extractRecentToolActivity(matchedDetail?.messages ?? [], limit),
    [matchedDetail, limit]
  );
}

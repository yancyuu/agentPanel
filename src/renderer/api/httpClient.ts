/**
 * HTTP-based implementation of ElectronAPI for browser mode.
 *
 * Replaces Electron IPC with fetch() for request/response and
 * EventSource (SSE) for real-time events. Allows the renderer
 * to run in a regular browser connected to an HTTP server.
 */

import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { DashboardRecentProjectsPayload } from '@features/recent-projects/contracts';
import type {
  AddMemberRequest,
  AppConfig,
  AttachmentFileData,
  BoardTaskActivityDetailResult,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  CcSession,
  CcSessionDetail,
  ClaudeMdFileInfo,
  ClaudeRootFolderSelection,
  ClaudeRootInfo,
  CliInstallerAPI,
  ConfigAPI,
  ContextInfo,
  ConversationGroup,
  CreateScheduleInput,
  CreateTaskRequest,
  DiscoverableWorker,
  ElectronAPI,
  FileChangeEvent,
  GlobalTask,
  HttpServerAPI,
  HttpServerStatus,
  KanbanColumnId,
  LoopAssetsSnapshot,
  LoopSessionRequest,
  LoopSessionResponse,
  MachineProfile,
  MachineRuntimeProcess,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  NotificationsAPI,
  NotificationTrigger,
  PaginatedSessionsResult,
  Project,
  ReplaceMembersRequest,
  RepositoryGroup,
  Schedule,
  ScheduleChangeEvent,
  ScheduleRun,
  SearchSessionsResult,
  SendMessageRequest,
  SendMessageResult,
  Session,
  SessionAPI,
  SessionDetail,
  SessionMetrics,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SnippetDiff,
  SshAPI,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionStatus,
  SshLastConnection,
  SubagentDetail,
  SystemManagerSummary,
  TaskAttachmentMeta,
  TeamAgentRuntimeSnapshot,
  TeamAssetsResponse,
  TeamChangeEvent,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMemberActivityMeta,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamsAPI,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamTemplateSource,
  TeamTemplateSourcesSnapshot,
  TeamUpdateConfigRequest,
  TeamViewSnapshot,
  ToolApprovalEvent,
  ToolApprovalFileContent,
  ToolApprovalSettings,
  TriggerTestResult,
  UpdateKanbanPatch,
  UpdaterAPI,
  UpdateSchedulePatch,
  WaterfallData,
  WslClaudeRootCandidate,
} from '@shared/types';
import type { AgentConfig } from '@shared/types/api';
import type { CliProviderStatus } from '@shared/types/cliInstaller';
import type { EditorAPI, ProjectAPI, WorkspaceListResponse } from '@shared/types/editor';
import type {
  CapabilityCommandPromptRequest,
  CapabilityCommandPromptResult,
  CapabilityPackExportRequest,
  CapabilityPackImportRequest,
  CapabilityPackListResult,
  CapabilityPackMutationResult,
  EnrichedPlugin,
  InstalledMcpEntry,
  McpCatalogItem,
  McpCustomInstallRequest,
  McpInstallRequest,
  McpLibraryEntry,
  McpLibraryImportRequest,
  McpLibraryImportResult,
  McpLibraryUpsertRequest,
  McpSearchResult,
  McpServerDiagnostic,
  OperationResult,
  PluginInstallRequest,
  SkillCatalogItem,
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillReviewPreview,
  SkillSource,
  SkillSourcesSnapshot,
  SkillUpsertRequest,
  SkillWatcherEvent,
} from '@shared/types/extensions';
import type { ImLiveWorker } from '@shared/types/imLiveWorker';
import type {
  AgentChangeSet,
  ApplyReviewResult,
  ChangeStats,
  ConflictCheckResult,
  FileChangeWithContent,
  HunkDecision,
  TaskChangeSetV2,
} from '@shared/types/review';
import type { ApplyReviewRequest } from '@shared/types/review';
import type { RuntimeReadiness } from '@shared/types/runtimeReadiness';
import type { SystemManagerAPI } from '@shared/types/systemManager';
import type { TerminalAPI } from '@shared/types/terminal';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

interface DesktopBridge {
  relaunch: () => Promise<void>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  openDeliveryFolder: (directory: string) => Promise<void>;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as Window & { agentpanelDesktop?: DesktopBridge }).agentpanelDesktop;
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' || target.protocol === 'http:';
  } catch {
    return false;
  }
}

function requestDesktopRelaunch(): Promise<void> {
  const controls = desktopBridge();
  if (!controls) {
    return Promise.reject(new Error('浏览器模式请手动重新启动本地工作台以应用外部渠道设置'));
  }
  return controls.relaunch();
}

function browserServerPort(baseUrl: string): number {
  try {
    const port = Number.parseInt(new URL(baseUrl).port, 10);
    return Number.isFinite(port) ? port : 5680;
  } catch {
    return 5680;
  }
}

export class HttpAPIClient implements ElectronAPI {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private eventListeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    // SSE is initialized lazily to avoid failing in test environments
    // where EventSource is not available
  }

  // ---------------------------------------------------------------------------
  // SSE event infrastructure
  // ---------------------------------------------------------------------------

  private initEventSource(): void {
    if (this.eventSource) return;
    if (typeof EventSource === 'undefined') return;
    this.eventSource = new EventSource(`${this.baseUrl}/api/events`);
    this.eventSource.onopen = () => console.log('[HttpAPIClient] SSE connected');
    this.eventSource.onerror = () => {
      // Auto-reconnect is built into EventSource
      console.warn('[HttpAPIClient] SSE connection error, will reconnect...');
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private addEventListener(channel: string, callback: (...args: any[]) => void): () => void {
    this.initEventSource();
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
      // Register SSE listener for this channel once
      this.eventSource?.addEventListener(channel, ((event: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(event.data as string);
        } catch (err) {
          // Keep-alive comment frames or non-JSON payloads must not break the
          // listener chain — drop the frame and surface it for debugging.
          console.warn('[HttpAPIClient] SSE frame is not valid JSON, skipping', err);
          return;
        }
        const listeners = this.eventListeners.get(channel);
        listeners?.forEach((cb) => cb(data));
      }) as EventListener);
    }
    this.eventListeners.get(channel)!.add(callback);

    return () => {
      this.eventListeners.get(channel)?.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * JSON reviver that converts ISO 8601 date strings back to Date objects.
   * Electron IPC preserves Date instances via structured clone, but HTTP JSON
   * serialization turns them into strings. This restores them so that
   * `.getTime()` and other Date methods work in the renderer.
   *
   * Field-scoped: a bare ISO-looking string inside a free-text field (message
   * content, tool result text, error, …) is NOT converted — otherwise it would
   * turn into a Date, break message classification (`typeof content === 'string'`)
   * and crash `.startsWith()`/`.slice()` on the rendered text.
   */
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern with bounded quantifier; no backtracking risk
  private static readonly ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/;

  private static readonly TEXT_FIELD_NAMES = new Set([
    'content',
    'text',
    'message',
    'error',
    'reason',
    'subject',
    'summary',
    'snippet',
    'name',
    'title',
    'description',
    'command',
    'cwd',
    'input',
    'output',
    'result',
    'rawContent',
    'originalText',
    'replyText',
  ]);

  private static reviveDates(key: string, value: unknown): unknown {
    if (
      typeof value === 'string' &&
      !HttpAPIClient.TEXT_FIELD_NAMES.has(key) &&
      HttpAPIClient.ISO_DATE_RE.test(value)
    ) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d;
    }
    return value;
  }

  private createTimeoutController(timeoutMs: number): {
    controller: AbortController;
    timeout: ReturnType<typeof setTimeout>;
  } {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    return { controller, timeout };
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      if (!text.trim()) throw new Error(`HTTP ${res.status}`);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        throw e;
      }
    }
    if (!text.trim()) return undefined as unknown as T;
    return JSON.parse(text, (key, value) => HttpAPIClient.reviveDates(key, value)) as T;
  }

  private async get<T>(path: string, timeoutMs = 10_000): Promise<T> {
    const { controller, timeout } = this.createTimeoutController(timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJsonWithBody<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000
  ): Promise<T> {
    const { controller, timeout } = this.createTimeoutController(timeoutMs);
    try {
      const headers: Record<string, string> | undefined =
        body !== undefined ? { 'Content-Type': 'application/json' } : undefined;
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    return this.requestJsonWithBody<T>('POST', path, body, timeoutMs);
  }

  private async postLong<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    return this.post<T>(path, body, timeoutMs);
  }

  private async patch<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    return this.requestJsonWithBody<T>('PATCH', path, body, timeoutMs);
  }

  private async del<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    return this.requestJsonWithBody<T>('DELETE', path, body, timeoutMs);
  }

  private async put<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    return this.requestJsonWithBody<T>('PUT', path, body, timeoutMs);
  }

  private async delete<T>(path: string, timeoutMs = 10_000): Promise<T> {
    return this.requestJsonWithBody<T>('DELETE', path, undefined, timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Core session/project APIs
  // ---------------------------------------------------------------------------

  getAppVersion = (): Promise<string> => this.get<string>('/api/version');

  hermitConfig = {
    get: async (): Promise<{
      ccBaseUrl: string;
      ccBridgeUrl: string;
      ccToken: string;
      ccTokenSet: boolean;
    }> => {
      const res = await this.get<{
        ok: boolean;
        data: { ccBaseUrl: string; ccBridgeUrl: string; ccToken: string; ccTokenSet: boolean };
      }>('/api/hermit-config');
      return res.data;
    },
    update: async (patch: {
      ccBaseUrl?: string;
      ccToken?: string;
      ccBridgeUrl?: string;
    }): Promise<void> => {
      await this.post('/api/hermit-config', patch);
    },
    getRaw: async (): Promise<{ path: string; content: string }> => {
      const res = await this.get<{ ok: boolean; data: { path: string; content: string } }>(
        '/api/hermit-config/raw'
      );
      return res.data;
    },
    updateRaw: async (content: string): Promise<void> => {
      await this.post('/api/hermit-config/raw', { content });
    },
  };

  ccConfig = {
    get: async (): Promise<Record<string, unknown>> => {
      const res = await this.get<{ ok: boolean; data: Record<string, unknown> }>('/api/cc-config');
      return res.data;
    },
    update: async (patch: Record<string, unknown>): Promise<{ needsRestart: boolean }> => {
      const res = await this.post<{ ok: boolean; data: { needsRestart: boolean } }>(
        '/api/cc-config',
        patch
      );
      return res.data;
    },
    getRaw: async (): Promise<{ path: string; content: string }> => {
      const res = await this.get<{ ok: boolean; data: { path: string; content: string } }>(
        '/api/cc-config/raw'
      );
      return res.data;
    },
    updateRaw: async (content: string): Promise<void> => {
      await this.post('/api/cc-config/raw', { content });
    },
  };

  ccSettings = {
    get: async (): Promise<Record<string, unknown>> => {
      const res = await this.get<{ ok: boolean; data: Record<string, unknown> }>(
        '/api/cc-settings'
      );
      return res.data;
    },
    patch: async (patch: Record<string, unknown>): Promise<void> => {
      await this.patch('/api/cc-settings', patch);
    },
    restart: async (): Promise<void> => {
      await this.postLong('/api/cc-restart', {});
    },
    reload: async (): Promise<void> => {
      await this.post('/api/cc-reload', {});
    },
  };

  externalChannels = {
    get: async (): Promise<{
      ccConnect: {
        enabled: boolean;
        active: boolean;
        restartRequired: boolean;
        state: 'disabled' | 'restart-required' | 'starting' | 'running' | 'offline';
      };
    }> => this.get('/api/external-channels'),
    setCcConnectEnabled: async (
      enabled: boolean
    ): Promise<{
      ccConnect: {
        enabled: boolean;
        active: boolean;
        restartRequired: boolean;
        state: 'disabled' | 'restart-required' | 'starting' | 'running' | 'offline';
      };
    }> => {
      const response = await this.put<{
        ok: boolean;
        data?: {
          ccConnect: {
            enabled: boolean;
            active: boolean;
            restartRequired: boolean;
            state: 'disabled' | 'restart-required' | 'starting' | 'running' | 'offline';
          };
        };
        error?: string;
      }>('/api/external-channels/cc-connect', { enabled });
      if (!response.ok || !response.data) throw new Error(response.error ?? '保存外部渠道设置失败');
      return response.data;
    },
  };

  githubDelivery = {
    listBindings: async (): Promise<
      { agentName: string; repository: string; branch: string; transport: 'https' | 'ssh' }[]
    > => {
      const response = await this.get<{
        ok: boolean;
        data: {
          agentName: string;
          repository: string;
          branch: string;
          transport: 'https' | 'ssh';
        }[];
      }>('/api/github-delivery/bindings');
      return response.data;
    },
    saveBinding: async (
      agentName: string,
      binding: { repository: string; branch?: string; transport?: 'https' | 'ssh' }
    ): Promise<{
      agentName: string;
      repository: string;
      branch: string;
      transport: 'https' | 'ssh';
    }> => {
      const response = await this.put<{
        ok: boolean;
        data?: {
          agentName: string;
          repository: string;
          branch: string;
          transport: 'https' | 'ssh';
        };
        error?: string;
      }>(`/api/github-delivery/bindings/${encodeURIComponent(agentName)}`, binding);
      if (!response.ok || !response.data) throw new Error(response.error ?? '保存 GitHub 仓库失败');
      return response.data;
    },
    deleteBinding: async (agentName: string): Promise<void> => {
      const response = await fetch(
        `${this.baseUrl}/api/github-delivery/bindings/${encodeURIComponent(agentName)}`,
        { method: 'DELETE' }
      );
      if (response.status === 204) return;
      await this.parseJson<{ ok: boolean }>(response);
    },
    publish: async (request: {
      teamName: string;
      taskId: string;
      agentName: string;
    }): Promise<{
      repository: string;
      branch: string;
      path: string;
      commit: string;
      url: string | null;
    }> => {
      const response = await this.post<{
        ok: boolean;
        data?: {
          repository: string;
          branch: string;
          path: string;
          commit: string;
          url: string | null;
        };
        error?: string;
      }>('/api/github-delivery/publish', request, 120_000);
      if (!response.ok || !response.data) throw new Error(response.error ?? '发布 GitHub 成果失败');
      return response.data;
    },
    getArchiveInfo: async (
      teamName: string,
      taskId: string
    ): Promise<{ outputDir: string; versionDir: string; title: string; versionId: string }> => {
      const response = await this.get<{
        ok: boolean;
        data?: { outputDir: string; versionDir: string; title: string; versionId: string };
        error?: string;
      }>(
        `/api/github-delivery/archive/${encodeURIComponent(teamName)}/${encodeURIComponent(taskId)}`
      );
      if (!response.ok || !response.data) throw new Error(response.error ?? '读取成果目录失败');
      return response.data;
    },
    downloadArchive: async (teamName: string, taskId: string): Promise<Blob> => {
      const response = await fetch(
        `${this.baseUrl}/api/github-delivery/archive/${encodeURIComponent(teamName)}/${encodeURIComponent(taskId)}.zip`
      );
      if (!response.ok) {
        const text = await response.text();
        try {
          const payload = JSON.parse(text) as { error?: string };
          throw new Error(payload.error ?? '下载成果 ZIP 失败');
        } catch (error) {
          if (error instanceof SyntaxError) throw new Error('下载成果 ZIP 失败');
          throw error;
        }
      }
      return response.blob();
    },
  };

  // cc-connect setup flows (QR code + manual platform binding)
  ccSetup = {
    feishuBegin: async (): Promise<{
      device_code: string;
      qr_url: string;
      base_url?: string;
      interval: number;
      expires_in: number;
    }> => {
      const res = await this.post<{
        ok: boolean;
        data: {
          device_code: string;
          qr_url: string;
          base_url?: string;
          interval: number;
          expires_in: number;
        };
      }>('/api/setup/feishu/begin', {});
      return res.data;
    },
    feishuPoll: async (
      deviceCode: string,
      baseUrl?: string
    ): Promise<{
      status: string;
      base_url?: string;
      app_id?: string;
      app_secret?: string;
      platform?: string;
      owner_open_id?: string;
      slow_down?: boolean;
      error?: string;
    }> => {
      const res = await this.post<{
        ok: boolean;
        data: {
          status: string;
          base_url?: string;
          app_id?: string;
          app_secret?: string;
          platform?: string;
          owner_open_id?: string;
          slow_down?: boolean;
          error?: string;
        };
      }>('/api/setup/feishu/poll', { device_code: deviceCode, base_url: baseUrl });
      return res.data;
    },
    feishuSave: async (params: {
      project: string;
      app_id: string;
      app_secret: string;
      platform_type?: string;
      owner_open_id?: string;
      work_dir?: string;
      agent_type?: string;
    }): Promise<{ message: string; restart_required: boolean; restart_handled?: boolean }> => {
      const res = await this.post<{
        ok: boolean;
        data: { message: string; restart_required: boolean; restart_handled?: boolean };
      }>('/api/setup/feishu/save', params);
      return res.data;
    },

    weixinBegin: async (
      apiUrl?: string
    ): Promise<{
      qr_key: string;
      qr_url: string;
      api_url?: string;
    }> => {
      const res = await this.post<{
        ok: boolean;
        data: { qr_key: string; qr_url: string; api_url?: string };
      }>('/api/setup/weixin/begin', { api_url: apiUrl });
      return res.data;
    },
    weixinPoll: async (
      qrKey: string,
      apiUrl?: string
    ): Promise<{
      status: string;
      bot_token?: string;
      ilink_bot_id?: string;
      base_url?: string;
      ilink_user_id?: string;
    }> => {
      const res = await this.post<{
        ok: boolean;
        data: {
          status: string;
          bot_token?: string;
          ilink_bot_id?: string;
          base_url?: string;
          ilink_user_id?: string;
        };
      }>('/api/setup/weixin/poll', { qr_key: qrKey, api_url: apiUrl });
      return res.data;
    },
    weixinSave: async (params: {
      project: string;
      token: string;
      base_url?: string;
      ilink_bot_id?: string;
      ilink_user_id?: string;
      work_dir?: string;
      agent_type?: string;
    }): Promise<{ message: string; restart_required: boolean; restart_handled?: boolean }> => {
      const res = await this.post<{
        ok: boolean;
        data: { message: string; restart_required: boolean; restart_handled?: boolean };
      }>('/api/setup/weixin/save', params);
      return res.data;
    },

    addPlatform: async (
      projectName: string,
      body: {
        type: string;
        options?: Record<string, unknown>;
        work_dir?: string;
        agent_type?: string;
      }
    ): Promise<{ message: string; restart_required: boolean; restart_handled?: boolean }> => {
      const res = await this.postLong<{
        ok?: boolean;
        data?: { message: string; restart_required: boolean; restart_handled?: boolean };
        error?: string;
      }>(`/api/projects/${encodeURIComponent(projectName)}/add-platform`, body, 120_000);
      if (res.ok === false || !res.data) {
        throw new Error(res.error ?? '绑定平台失败：服务未返回结果');
      }
      return res.data;
    },
  };

  getDashboardRecentProjects = (): Promise<DashboardRecentProjectsPayload> =>
    this.get<DashboardRecentProjectsPayload>('/api/dashboard/recent-projects');

  getProjects = (): Promise<Project[]> => this.get<Project[]>('/api/projects');

  getSessions = (projectId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);

  getSessionsPaginated = (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: SessionsPaginationOptions
  ): Promise<PaginatedSessionsResult> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    if (options?.includeTotalCount === false) params.set('includeTotalCount', 'false');
    if (options?.prefilterAll === false) params.set('prefilterAll', 'false');
    if (options?.metadataLevel) params.set('metadataLevel', options.metadataLevel);
    const qs = params.toString();
    const encodedId = encodeURIComponent(projectId);
    const path = `/api/projects/${encodedId}/sessions-paginated`;
    return this.get<PaginatedSessionsResult>(qs ? `${path}?${qs}` : path);
  };

  searchSessions = (
    projectId: string,
    query: string,
    maxResults?: number
  ): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(
      `/api/projects/${encodeURIComponent(projectId)}/search?${params}`
    );
  };

  searchAllProjects = (query: string, maxResults?: number): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(`/api/search?${params}`);
  };

  getSessionDetail = (
    projectId: string,
    sessionId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SessionDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SessionDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
    );
  };

  getSessionMetrics = (projectId: string, sessionId: string): Promise<SessionMetrics | null> =>
    this.get<SessionMetrics | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/metrics`
    );

  getWaterfallData = (projectId: string, sessionId: string): Promise<WaterfallData | null> =>
    this.get<WaterfallData | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/waterfall`
    );

  getSubagentDetail = (
    projectId: string,
    sessionId: string,
    subagentId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SubagentDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SubagentDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}${suffix}`
    );
  };

  getSessionGroups = (projectId: string, sessionId: string): Promise<ConversationGroup[]> =>
    this.get<ConversationGroup[]>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/groups`
    );

  getSessionsByIds = (
    projectId: string,
    sessionIds: string[],
    options?: SessionsByIdsOptions
  ): Promise<Session[]> =>
    this.post<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions-by-ids`, {
      sessionIds,
      metadataLevel: options?.metadataLevel,
    });

  // ---------------------------------------------------------------------------
  // Repository grouping
  // ---------------------------------------------------------------------------

  getRepositoryGroups = (): Promise<RepositoryGroup[]> =>
    this.get<RepositoryGroup[]>('/api/repository-groups');

  getWorktreeSessions = (worktreeId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/sessions`);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validatePath = (
    relativePath: string,
    projectPath: string
  ): Promise<{ exists: boolean; isDirectory?: boolean }> =>
    this.post<{ exists: boolean; isDirectory?: boolean }>('/api/validate/path', {
      relativePath,
      projectPath,
    });

  validateMentions = (
    mentions: { type: 'path'; value: string }[],
    projectPath: string
  ): Promise<Record<string, boolean>> =>
    this.post<Record<string, boolean>>('/api/validate/mentions', { mentions, projectPath });

  // ---------------------------------------------------------------------------
  // CLAUDE.md reading
  // ---------------------------------------------------------------------------

  readClaudeMdFiles = (projectRoot: string): Promise<Record<string, ClaudeMdFileInfo>> =>
    this.post<Record<string, ClaudeMdFileInfo>>('/api/read-claude-md', { projectRoot });

  readDirectoryClaudeMd = (dirPath: string): Promise<ClaudeMdFileInfo> =>
    this.post<ClaudeMdFileInfo>('/api/read-directory-claude-md', { dirPath });

  readMentionedFile = (
    absolutePath: string,
    projectRoot: string,
    maxTokens?: number
  ): Promise<ClaudeMdFileInfo | null> =>
    this.post<ClaudeMdFileInfo | null>('/api/read-mentioned-file', {
      absolutePath,
      projectRoot,
      maxTokens,
    });

  // ---------------------------------------------------------------------------
  // Agent config reading
  // ---------------------------------------------------------------------------

  readAgentConfigs = (projectRoot: string): Promise<Record<string, AgentConfig>> =>
    this.post<Record<string, AgentConfig>>('/api/read-agent-configs', { projectRoot });

  // ---------------------------------------------------------------------------
  // Notifications (nested API)
  // ---------------------------------------------------------------------------

  notifications: NotificationsAPI = {
    get: (options) =>
      this.get(
        `/api/notifications?${new URLSearchParams(
          options
            ? {
                limit: String(options.limit ?? 20),
                offset: String(options.offset ?? 0),
              }
            : {}
        )}`
      ),
    markRead: (id) => this.post(`/api/notifications/${encodeURIComponent(id)}/read`),
    markAllRead: () => this.post('/api/notifications/read-all'),
    delete: (id) => this.del(`/api/notifications/${encodeURIComponent(id)}`),
    clear: () => this.del('/api/notifications'),
    getUnreadCount: () => this.get('/api/notifications/unread-count'),
    testNotification: async () => ({
      success: false,
      error: 'Test notifications require Electron (not available in browser mode)',
    }),
    // IPC signature: (event: unknown, error: unknown) => void
    onNew: (callback) =>
      this.addEventListener('notification:new', (data: unknown) => callback(null, data)),
    // IPC signature: (event: unknown, payload: { total; unreadCount }) => void
    onUpdated: (callback) =>
      this.addEventListener('notification:updated', (data: unknown) =>
        callback(null, data as { total: number; unreadCount: number })
      ),
    // IPC signature: (event: unknown, data: unknown) => void
    onClicked: (callback) =>
      this.addEventListener('notification:clicked', (data: unknown) => callback(null, data)),
  };

  // ---------------------------------------------------------------------------
  // Config (nested API)
  // ---------------------------------------------------------------------------

  config: ConfigAPI = {
    get: async (): Promise<AppConfig> => {
      const result = await this.get<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config'
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to get config');
      return result.data!;
    },
    update: async (section: string, data: object): Promise<AppConfig> => {
      const result = await this.post<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config/update',
        { section, data }
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to update config');
      return result.data!;
    },
    addIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    removeIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    addIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    removeIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    snooze: async (minutes: number): Promise<AppConfig> => {
      await this.post('/api/config/snooze', { minutes });
      return this.config.get();
    },
    clearSnooze: async (): Promise<AppConfig> => {
      await this.post('/api/config/clear-snooze');
      return this.config.get();
    },
    addTrigger: async (trigger): Promise<AppConfig> => {
      await this.post('/api/config/triggers', trigger);
      return this.config.get();
    },
    updateTrigger: async (triggerId: string, updates): Promise<AppConfig> => {
      await this.put(`/api/config/triggers/${encodeURIComponent(triggerId)}`, updates);
      return this.config.get();
    },
    removeTrigger: async (triggerId: string): Promise<AppConfig> => {
      await this.del(`/api/config/triggers/${encodeURIComponent(triggerId)}`);
      return this.config.get();
    },
    getTriggers: async (): Promise<NotificationTrigger[]> => {
      const result = await this.get<{
        success: boolean;
        data?: NotificationTrigger[];
        error?: string;
      }>('/api/config/triggers');
      if (!result.success) throw new Error(result.error ?? 'Failed to get triggers');
      return result.data ?? [];
    },
    testTrigger: async (trigger: NotificationTrigger): Promise<TriggerTestResult> => {
      const result = await this.post<{
        success: boolean;
        data?: TriggerTestResult;
        error?: string;
      }>(`/api/config/triggers/${encodeURIComponent(trigger.id)}/test`, trigger);
      if (!result.success) throw new Error(result.error ?? 'Failed to test trigger');
      return result.data!;
    },
    selectFolders: async (): Promise<string[]> => {
      // Fallback: return home directory as default
      return [process.env.HOME ?? '/'];
    },
    browseFolders: async (
      dirPath?: string
    ): Promise<{ path: string; dirs: string[]; hasParent: boolean }> => {
      const res = await this.post<{
        success: boolean;
        data?: { path: string; dirs: string[]; hasParent: boolean };
        error?: string;
      }>('/api/config/browse-folders', { path: dirPath ?? '' });
      if (!res.success) throw new Error(res.error ?? '无法浏览目录');
      return res.data!;
    },
    selectClaudeRootFolder: async (): Promise<ClaudeRootFolderSelection | null> => {
      console.warn('[HttpAPIClient] selectClaudeRootFolder is not available in browser mode');
      return null;
    },
    getClaudeRootInfo: async (): Promise<ClaudeRootInfo> => {
      const config = await this.config.get();
      const fallbackPath = config.general.claudeRootPath ?? '~/.claude';
      return {
        defaultPath: fallbackPath,
        resolvedPath: fallbackPath,
        customPath: config.general.claudeRootPath,
      };
    },
    findWslClaudeRoots: async (): Promise<WslClaudeRootCandidate[]> => {
      console.warn('[HttpAPIClient] findWslClaudeRoots is not available in browser mode');
      return [];
    },
    openInEditor: async (): Promise<void> => {
      console.warn('[HttpAPIClient] openInEditor is not available in browser mode');
    },
    pinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/pin-session', { projectId, sessionId }),
    unpinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unpin-session', { projectId, sessionId }),
    hideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/hide-session', { projectId, sessionId }),
    unhideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unhide-session', { projectId, sessionId }),
    hideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/hide-sessions', { projectId, sessionIds }),
    unhideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/unhide-sessions', { projectId, sessionIds }),
    addCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/add-custom-project-path', { projectPath }),
    removeCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/remove-custom-project-path', { projectPath }),
    getClaudeEnv: async (): Promise<Record<string, string>> => {
      const result = await this.get<{
        success: boolean;
        data?: Record<string, string>;
        error?: string;
      }>('/api/config/claude-env');
      if (!result.success) throw new Error(result.error ?? 'Failed to get claude env');
      return result.data ?? {};
    },
    updateClaudeEnv: async (env: Record<string, string>): Promise<Record<string, string>> => {
      const result = await this.post<{
        success: boolean;
        data?: Record<string, string>;
        error?: string;
      }>('/api/config/claude-env', env);
      if (!result.success) throw new Error(result.error ?? 'Failed to update claude env');
      return result.data ?? env;
    },
  };

  // ---------------------------------------------------------------------------
  // Session navigation
  // ---------------------------------------------------------------------------

  session: SessionAPI = {
    scrollToLine: (sessionId: string, lineNumber: number): Promise<void> =>
      this.post('/api/session/scroll-to-line', { sessionId, lineNumber }),
  };

  // ---------------------------------------------------------------------------
  // Zoom (browser fallbacks)
  // ---------------------------------------------------------------------------

  getZoomFactor = async (): Promise<number> => 1.0;

  onZoomFactorChanged = (_callback: (zoomFactor: number) => void): (() => void) => {
    // No-op in browser mode — zoom is managed by the browser itself
    return () => {};
  };

  // ---------------------------------------------------------------------------
  // File change events (via SSE)
  // ---------------------------------------------------------------------------

  onFileChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('file-change', callback);

  onTodoChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('todo-change', callback);

  // ---------------------------------------------------------------------------
  // IM live workers (via SSE) — hermit-bridge session watcher push
  // ---------------------------------------------------------------------------

  onImLiveWorkers = (callback: (workers: ImLiveWorker[]) => void): (() => void) =>
    this.addEventListener('im-live-workers', (data) => callback((data ?? []) as ImLiveWorker[]));

  // ---------------------------------------------------------------------------
  // Shell operations (browser fallbacks)
  // ---------------------------------------------------------------------------

  openPath = async (
    _targetPath: string,
    _projectRoot?: string
  ): Promise<{ success: boolean; error?: string }> => {
    console.warn('[HttpAPIClient] openPath is not available in browser mode');
    return { success: false, error: 'Not available in browser mode' };
  };

  showInFolder = async (filePath: string): Promise<void> => {
    const bridge = desktopBridge();
    if (!bridge) throw new Error('浏览器模式无法打开本地成果文件夹');
    await bridge.openDeliveryFolder(filePath);
  };

  openExternal = async (url: string): Promise<{ success: boolean; error?: string }> => {
    if (!isSafeExternalUrl(url)) return { success: false, error: '不支持打开该链接' };
    const bridge = desktopBridge();
    if (bridge) return bridge.openExternal(url);
    return { success: false, error: '浏览器模式无法打开外部链接' };
  };

  windowControls = {
    minimize: async (): Promise<void> => {},
    maximize: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
    isMaximized: async (): Promise<boolean> => false,
    isFullScreen: async (): Promise<boolean> => false,
    relaunch: (): Promise<void> => requestDesktopRelaunch(),
  };

  onFullScreenChange =
    (_callback: (isFullScreen: boolean) => void): (() => void) =>
    () => {};

  // ---------------------------------------------------------------------------
  // Updater (browser no-ops)
  // ---------------------------------------------------------------------------

  updater: UpdaterAPI = {
    check: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    download: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    onStatus: (_callback): (() => void) => {
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // SSH
  // ---------------------------------------------------------------------------

  ssh: SshAPI = {
    connect: async (config: SshConnectionConfig): Promise<SshConnectionStatus> => {
      const result = await this.post<{
        success: boolean;
        data?: SshConnectionStatus;
        error?: string;
      }>('/api/ssh/connect', config);
      if (!result.success) throw new Error(result.error ?? 'SSH connect failed');
      return result.data!;
    },
    disconnect: async (): Promise<SshConnectionStatus> => {
      const result = await this.post<{
        success: boolean;
        data?: SshConnectionStatus;
        error?: string;
      }>('/api/ssh/disconnect');
      if (!result.success) throw new Error(result.error ?? 'SSH disconnect failed');
      return result.data!;
    },
    getState: (): Promise<SshConnectionStatus> => this.get('/api/ssh/state'),
    test: async (config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> => {
      const result = await this.post<{
        success: boolean;
        data?: { success: boolean; error?: string };
        error?: string;
      }>('/api/ssh/test', config);
      if (!result.success) return { success: false, error: result.error };
      return result.data ?? { success: true };
    },
    listMachines: async () => {
      const result = await this.get<{ success: boolean; data?: MachineProfile[] }>(
        '/api/ssh/machines'
      );
      return result.data ?? [];
    },
    saveMachine: async (profile: MachineProfile) => {
      const result = await this.post<{ success: boolean; data?: MachineProfile[] }>(
        '/api/ssh/machines',
        profile
      );
      return result.data ?? [];
    },
    removeMachine: async (machineId: string) => {
      const result = await this.del<{ success: boolean; data?: MachineProfile[] }>(
        `/api/ssh/machines/${encodeURIComponent(machineId)}`
      );
      return result.data ?? [];
    },
    checkMachine: async (machineId: string) => {
      const result = await this.post<{ success: boolean; data?: MachineProfile }>(
        `/api/ssh/machines/${encodeURIComponent(machineId)}/check`
      );
      if (!result.data) {
        throw new Error('机器健康检查没有返回数据');
      }
      return result.data;
    },
    listMachineProcesses: async (machineId: string) => {
      const result = await this.get<{ success: boolean; data?: MachineRuntimeProcess[] }>(
        `/api/ssh/machines/${encodeURIComponent(machineId)}/processes`
      );
      return result.data ?? [];
    },
    stopMachineProcess: async (machineId: string, pid: number) => {
      await this.post(`/api/ssh/machines/${encodeURIComponent(machineId)}/processes/stop`, {
        pid,
      });
    },
    getConfigHosts: async (): Promise<SshConfigHostEntry[]> => {
      const result = await this.get<{ success: boolean; data?: SshConfigHostEntry[] }>(
        '/api/ssh/config-hosts'
      );
      return result.data ?? [];
    },
    resolveHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
      const result = await this.post<{
        success: boolean;
        data?: SshConfigHostEntry | null;
      }>('/api/ssh/resolve-host', { alias });
      return result.data ?? null;
    },
    saveLastConnection: (config: SshLastConnection): Promise<void> =>
      this.post('/api/ssh/save-last-connection', config),
    getLastConnection: async (): Promise<SshLastConnection | null> => {
      const result = await this.get<{ success: boolean; data?: SshLastConnection | null }>(
        '/api/ssh/last-connection'
      );
      return result.data ?? null;
    },
    // IPC signature: (event: unknown, status: SshConnectionStatus) => void
    onStatus: (callback): (() => void) =>
      this.addEventListener('ssh:status', (data: unknown) =>
        callback(null, data as SshConnectionStatus)
      ),
  };

  // ---------------------------------------------------------------------------
  // Context API
  // ---------------------------------------------------------------------------

  context = {
    list: (): Promise<ContextInfo[]> => this.get<ContextInfo[]>('/api/contexts'),
    getActive: (): Promise<string> => this.get<string>('/api/contexts/active'),
    switch: (contextId: string): Promise<{ contextId: string }> =>
      this.post<{ contextId: string }>('/api/contexts/switch', { contextId }),
    onChanged: (callback: (event: unknown, data: ContextInfo) => void): (() => void) =>
      this.addEventListener('context:changed', (data: unknown) =>
        callback(null, data as ContextInfo)
      ),
  };

  // HTTP Server API — in browser mode, server is already running (we're using it)
  httpServer: HttpServerAPI = {
    start: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: browserServerPort(this.baseUrl) }),
    stop: (): Promise<HttpServerStatus> => {
      console.warn('[HttpAPIClient] Cannot stop HTTP server from browser mode');
      return Promise.resolve({ running: true, port: browserServerPort(this.baseUrl) });
    },
    getStatus: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: browserServerPort(this.baseUrl) }),
  };

  teams: TeamsAPI = {
    list: async (): Promise<TeamSummary[]> => this.get<TeamSummary[]>('/api/teams', 30_000),
    ensureSystemManager: async (): Promise<SystemManagerSummary> =>
      this.post<SystemManagerSummary>('/api/system-manager/ensure'),
    getData: async (teamName: string): Promise<TeamViewSnapshot> =>
      this.get<TeamViewSnapshot>(`/api/teams/${encodeURIComponent(teamName)}/data`, 30_000),
    getLoopAssets: async (teamName: string): Promise<LoopAssetsSnapshot> =>
      this.get<LoopAssetsSnapshot>(
        `/api/teams/${encodeURIComponent(teamName)}/loop-assets`,
        30_000
      ),
    createLoopSession: async (
      teamName: string,
      request: LoopSessionRequest
    ): Promise<LoopSessionResponse> =>
      this.postLong<LoopSessionResponse>(
        `/api/teams/${encodeURIComponent(teamName)}/loop-session`,
        request,
        30_000
      ),
    getTaskChangePresence: async (): Promise<
      Record<string, 'has_changes' | 'no_changes' | 'unknown'>
    > => {
      return {};
    },
    setChangePresenceTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    setTaskLogStreamTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    setToolActivityTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    getClaudeLogs: async (
      teamName: string,
      query?: TeamClaudeLogsQuery
    ): Promise<TeamClaudeLogsResponse> => {
      const params = new URLSearchParams();
      if (typeof query?.offset === 'number') params.set('offset', String(query.offset));
      if (typeof query?.limit === 'number') params.set('limit', String(query.limit));
      const qs = params.toString();
      const path = `/api/teams/${encodeURIComponent(teamName)}/claude-logs`;
      return this.get<TeamClaudeLogsResponse>(qs ? `${path}?${qs}` : path);
    },
    deleteTeam: async (teamName: string): Promise<{ restartRequired?: boolean }> => {
      return this.del<{ restartRequired?: boolean }>(`/api/teams/${encodeURIComponent(teamName)}`);
    },
    restoreTeam: async (teamName: string): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/restore`);
    },
    permanentlyDeleteTeam: async (teamName: string): Promise<void> => {
      await this.del(`/api/teams/${encodeURIComponent(teamName)}/permanent`);
    },
    getSavedRequest: async (teamName: string): Promise<TeamCreateRequest | null> => {
      try {
        return await this.get(`/api/teams/${encodeURIComponent(teamName)}/saved-request`);
      } catch {
        return null;
      }
    },
    deleteDraft: async (teamName: string): Promise<void> => {
      await this.del(`/api/teams/${encodeURIComponent(teamName)}/draft`);
    },
    prepareProvisioning: async (
      cwd?: string,
      providerId?: TeamLaunchRequest['providerId'],
      providerIds?: TeamLaunchRequest['providerId'][],
      selectedModels?: string[],
      limitContext?: boolean,
      modelVerificationMode?: TeamProvisioningModelVerificationMode
    ): Promise<TeamProvisioningPrepareResult> => {
      return this.post<TeamProvisioningPrepareResult>('/api/teams/provisioning/prepare', {
        cwd,
        providerId,
        providerIds,
        selectedModels,
        limitContext,
        modelVerificationMode,
      });
    },
    listTemplateSources: async (): Promise<TeamTemplateSourcesSnapshot> => {
      return this.get<TeamTemplateSourcesSnapshot>('/api/teams/templates');
    },
    saveTemplateSources: async (
      sources: TeamTemplateSource[]
    ): Promise<TeamTemplateSourcesSnapshot> => {
      return this.post<TeamTemplateSourcesSnapshot>('/api/teams/templates/save', sources);
    },
    refreshTemplateSources: async (): Promise<TeamTemplateSourcesSnapshot> => {
      return this.postLong<TeamTemplateSourcesSnapshot>('/api/teams/templates/refresh');
    },
    createTeam: async (request: TeamCreateRequest): Promise<TeamCreateResponse> => {
      return this.postLong<TeamCreateResponse>('/api/teams/create', request, 120_000);
    },
    launchTeam: async (request: TeamLaunchRequest): Promise<TeamLaunchResponse> => {
      return this.postLong<TeamLaunchResponse>(
        `/api/teams/${encodeURIComponent(request.teamName)}/launch`,
        request
      );
    },
    getProvisioningStatus: async (runId: string): Promise<TeamProvisioningProgress> => {
      return this.get<TeamProvisioningProgress>(
        `/api/teams/provisioning/${encodeURIComponent(runId)}`
      );
    },
    cancelProvisioning: async (runId: string): Promise<void> => {
      await this.post(`/api/teams/provisioning/${encodeURIComponent(runId)}/cancel`);
    },
    sendMessage: async (
      teamName: string,
      request: SendMessageRequest
    ): Promise<SendMessageResult> =>
      this.postLong<SendMessageResult>(
        `/api/teams/${encodeURIComponent(teamName)}/send-message`,
        request,
        30_000
      ),
    getMessagesPage: async (
      teamName: string,
      opts?: { cursor?: string | null; limit?: number }
    ) => {
      const params = new URLSearchParams();
      if (opts?.cursor) params.set('cursor', opts.cursor);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const qs = params.toString();
      const path = `/api/teams/${encodeURIComponent(teamName)}/messages`;
      return this.get(qs ? `${path}?${qs}` : path);
    },
    getMemberActivityMeta: async (teamName: string): Promise<TeamMemberActivityMeta> =>
      this.get<TeamMemberActivityMeta>(
        `/api/teams/${encodeURIComponent(teamName)}/member-activity`
      ),
    createTask: async (teamName: string, request: CreateTaskRequest): Promise<TeamTask> =>
      this.post<TeamTask>(`/api/teams/${encodeURIComponent(teamName)}/tasks`, request),
    requestReview: async (teamName: string, taskId: string): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/review`
      );
    },
    updateKanban: async (
      teamName: string,
      taskId: string,
      patch: UpdateKanbanPatch
    ): Promise<void> => {
      await this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/kanban/${encodeURIComponent(taskId)}`,
        patch
      );
    },
    updateKanbanColumnOrder: async (
      teamName: string,
      columnId: KanbanColumnId,
      orderedTaskIds: string[]
    ): Promise<void> => {
      await this.put(`/api/teams/${encodeURIComponent(teamName)}/kanban/column-order`, {
        columnId,
        orderedTaskIds,
      });
    },
    updateTaskStatus: async (
      teamName: string,
      taskId: string,
      status: TeamTaskStatus
    ): Promise<void> => {
      await this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/status`,
        { status }
      );
    },
    updateTaskOwner: async (
      teamName: string,
      taskId: string,
      owner: string | null
    ): Promise<void> => {
      await this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/owner`,
        { owner }
      );
    },
    updateTaskFields: async (
      teamName: string,
      taskId: string,
      fields: { subject?: string; description?: string }
    ): Promise<void> => {
      await this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/fields`,
        fields
      );
    },
    startTask: async (teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> =>
      this.post<{ notifiedOwner: boolean }>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/start`
      ),
    startTaskByUser: async (
      teamName: string,
      taskId: string
    ): Promise<{ notifiedOwner: boolean }> =>
      this.post<{ notifiedOwner: boolean }>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/start-by-user`
      ),
    processSend: async (teamName: string, message: string): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/process-send`, { message });
    },
    setCollaboration: async (teamName: string, collaboration: boolean): Promise<void> => {
      await this.patch(`/api/teams/${encodeURIComponent(teamName)}/collaboration`, {
        collaboration,
      });
    },
    processAlive: async (teamName: string): Promise<boolean> => {
      try {
        const states = await this.get<
          { teamName: string; isAlive: boolean; runId: string | null }[]
        >('/api/teams/runtime/alive');
        return states.some((s) => s.teamName === teamName && s.isAlive);
      } catch {
        return false;
      }
    },
    aliveList: async (): Promise<string[]> => {
      const states = await this.get<{ teamName: string; isAlive: boolean; runId: string | null }[]>(
        '/api/teams/runtime/alive'
      );
      return states.filter((s) => s.isAlive).map((s) => s.teamName);
    },
    stop: async (teamName: string): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/stop`);
    },
    createConfig: async (request: TeamCreateConfigRequest): Promise<void> => {
      await this.post('/api/teams/config', request);
    },
    getMemberLogs: async (teamName: string, memberName: string): Promise<MemberLogSummary[]> => {
      return this.get<MemberLogSummary[]>(
        `/api/teams/${encodeURIComponent(teamName)}/member-logs/${encodeURIComponent(memberName)}`
      );
    },
    getLogsForTask: async (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
      }
    ): Promise<MemberLogSummary[]> => {
      const params = new URLSearchParams();
      if (options?.owner) params.set('owner', options.owner);
      if (options?.status) params.set('status', options.status);
      if (options?.intervals) params.set('intervals', JSON.stringify(options.intervals));
      if (options?.since) params.set('since', options.since);
      const qs = params.toString();
      const path = `/api/teams/${encodeURIComponent(teamName)}/task-logs/${encodeURIComponent(taskId)}`;
      return this.get(qs ? `${path}?${qs}` : path);
    },
    getTaskActivity: async (teamName: string, taskId: string) => {
      const params = new URLSearchParams();
      params.set('taskId', taskId);
      return this.get(`/api/teams/${encodeURIComponent(teamName)}/activity?${params}`);
    },
    getTaskActivityDetail: async (
      teamName: string,
      taskId: string,
      activityId: string
    ): Promise<BoardTaskActivityDetailResult> => {
      const params = new URLSearchParams();
      params.set('taskId', taskId);
      params.set('activityId', activityId);
      return this.get(`/api/teams/${encodeURIComponent(teamName)}/task-activity-detail?${params}`);
    },
    getTaskLogStreamSummary: async (
      teamName: string,
      taskId: string
    ): Promise<BoardTaskLogStreamSummary> => {
      return this.get(
        `/api/teams/${encodeURIComponent(teamName)}/task-log-stream-summary/${encodeURIComponent(taskId)}`
      );
    },
    getTaskLogStream: async (
      teamName: string,
      taskId: string
    ): Promise<BoardTaskLogStreamResponse> => {
      return this.get(
        `/api/teams/${encodeURIComponent(teamName)}/task-log-stream/${encodeURIComponent(taskId)}`
      );
    },
    getTaskExactLogSummaries: async (
      teamName: string,
      taskId: string
    ): Promise<BoardTaskExactLogSummariesResponse> => {
      return this.get(
        `/api/teams/${encodeURIComponent(teamName)}/exact-log-summaries/${encodeURIComponent(taskId)}`
      );
    },
    getTaskExactLogDetail: async (
      teamName: string,
      taskId: string,
      exactLogId: string,
      expectedSourceGeneration: string
    ): Promise<BoardTaskExactLogDetailResult> => {
      const params = new URLSearchParams();
      params.set('exactLogId', exactLogId);
      params.set('expectedSourceGeneration', expectedSourceGeneration);
      return this.get(
        `/api/teams/${encodeURIComponent(teamName)}/exact-log-detail/${encodeURIComponent(taskId)}?${params}`
      );
    },
    getMemberStats: async (teamName: string, memberName: string) => {
      return this.get<MemberFullStats>(
        `/api/teams/${encodeURIComponent(teamName)}/member-stats/${encodeURIComponent(memberName)}`
      );
    },
    getAllTasks: async (): Promise<GlobalTask[]> => this.get<GlobalTask[]>('/api/teams/tasks'),
    updateConfig: async (
      teamName: string,
      config: TeamUpdateConfigRequest
    ): Promise<TeamConfig> => {
      const result = await this.put<TeamConfig>(
        `/api/teams/${encodeURIComponent(teamName)}/config`,
        config,
        120_000
      );
      if (result.ccSyncError) {
        throw new Error(`配置已保存到本地，但同步到运行时失败：${result.ccSyncError}`);
      }
      return result;
    },
    addMember: async (teamName: string, request: AddMemberRequest): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/members`, request);
    },
    replaceMembers: async (teamName: string, request: ReplaceMembersRequest): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/members`, {
        action: 'replace',
        ...request,
      });
    },
    removeMember: async (teamName: string, memberName: string): Promise<void> => {
      await this.del(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}`
      );
    },
    updateMemberRole: async (
      teamName: string,
      memberName: string,
      role: string | undefined
    ): Promise<void> => {
      await this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/role`,
        { role }
      );
    },
    getProjectBranch: async (_projectPath: string): Promise<string | null> => {
      return null;
    },
    setProjectBranchTracking: async (): Promise<void> => {
      // Not available in browser mode — no-op.
    },
    getAttachments: async (teamName: string, messageId: string): Promise<AttachmentFileData[]> => {
      return this.get<AttachmentFileData[]>(
        `/api/teams/${encodeURIComponent(teamName)}/messages/${encodeURIComponent(messageId)}/attachments`
      );
    },
    killProcess: async (teamName: string, pid: number): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/kill-process`, { pid });
    },
    getLeadActivity: async (teamName: string) => {
      return this.get(`/api/teams/${encodeURIComponent(teamName)}/lead-activity`);
    },
    getLeadContext: async (teamName: string) => {
      return this.get(`/api/teams/${encodeURIComponent(teamName)}/lead-context`);
    },
    getMemberSpawnStatuses: async (teamName: string) => {
      try {
        return await this.get<MemberSpawnStatusesSnapshot>(
          `/api/teams/${encodeURIComponent(teamName)}/member-spawn-statuses`
        );
      } catch {
        return { statuses: {}, runId: null };
      }
    },
    getTeamAgentRuntime: async (teamName: string) => {
      try {
        return await this.get<TeamAgentRuntimeSnapshot>(
          `/api/teams/${encodeURIComponent(teamName)}/agent-runtime`
        );
      } catch {
        return {
          teamName,
          updatedAt: new Date().toISOString(),
          runId: null,
          members: {},
        };
      }
    },
    restartMember: async (teamName: string, memberName: string): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/restart`,
        undefined,
        30_000
      );
    },
    skipMemberForLaunch: async (teamName: string, memberName: string): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/skip`
      );
    },
    softDeleteTask: async (teamName: string, taskId: string): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/soft-delete`
      );
    },
    restoreTask: async (teamName: string, taskId: string): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/restore`
      );
    },
    getDeletedTasks: async (teamName: string): Promise<TeamTask[]> => {
      return this.get<TeamTask[]>(`/api/teams/${encodeURIComponent(teamName)}/deleted-tasks`);
    },
    setTaskClarification: async (
      teamName: string,
      taskId: string,
      value: 'lead' | 'user' | null
    ): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/task-clarification/${encodeURIComponent(taskId)}`,
        { value }
      );
    },
    showMessageNotification: async (): Promise<void> => {
      // Not available via HTTP client — native notifications require Electron
    },
    addTaskRelationship: async (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/relationships`,
        { targetId, type }
      );
    },
    removeTaskRelationship: async (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> => {
      await this.del(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/relationships`,
        { targetId, type }
      );
    },
    saveTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      filename: string,
      mimeType: string,
      base64Data: string
    ): Promise<TaskAttachmentMeta> => {
      return this.post<TaskAttachmentMeta>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments`,
        { attachmentId, filename, mimeType, base64Data }
      );
    },
    getTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      _mimeType: string
    ): Promise<string | null> => {
      const response = await this.get<{ base64Data?: string }>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`
      );
      return typeof response.base64Data === 'string' ? response.base64Data : null;
    },
    getTeamAssets: async (teamName: string): Promise<TeamAssetsResponse> => {
      return this.get<TeamAssetsResponse>(`/api/teams/${encodeURIComponent(teamName)}/assets`);
    },
    deleteTaskAttachment: async (
      teamName: string,
      taskId: string,
      attachmentId: string,
      _mimeType: string
    ): Promise<void> => {
      await this.del(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`
      );
    },
    onProjectBranchChange: (): (() => void) => {
      return () => {};
    },
    getTeamSessions: async (teamName: string): Promise<CcSession[]> =>
      this.get<CcSession[]>(`/api/teams/${encodeURIComponent(teamName)}/sessions`),
    getSessionDetail: async (
      teamName: string,
      sessionId: string,
      historyLimit: number = 50
    ): Promise<CcSessionDetail> => {
      const params = new URLSearchParams();
      if (historyLimit) params.set('history_limit', String(historyLimit));
      const qs = params.toString();
      const suffix = qs ? `?${qs}` : '';
      return this.get<CcSessionDetail>(
        `/api/teams/${encodeURIComponent(teamName)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
      );
    },
    cancelSession: async (teamName: string, sessionId: string): Promise<void> =>
      await this.delete(
        `/api/teams/${encodeURIComponent(teamName)}/sessions/${encodeURIComponent(sessionId)}`
      ),
    onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void): (() => void) => {
      return this.addEventListener('team-change', (data: unknown) =>
        callback(null, data as TeamChangeEvent)
      );
    },
    onProvisioningProgress: (
      callback: (event: unknown, data: TeamProvisioningProgress) => void
    ): (() => void) => {
      return this.addEventListener('provisioning-progress', (data: unknown) => {
        callback(null, data as TeamProvisioningProgress);
      });
    },
    respondToToolApproval: async (
      teamName: string,
      runId: string,
      requestId: string,
      allow: boolean,
      message?: string
    ): Promise<void> => {
      await this.post(`/api/teams/${encodeURIComponent(teamName)}/tool-approval/respond`, {
        runId,
        requestId,
        allow,
        message,
      });
    },
    validateCliArgs: async (rawArgs: string): Promise<CliArgsValidationResult> => {
      return this.post<CliArgsValidationResult>('/api/teams/validate-cli-args', { rawArgs });
    },
    onToolApprovalEvent: (
      callback: (event: unknown, data: ToolApprovalEvent) => void
    ): (() => void) => {
      return this.addEventListener('tool-approval-event', (data: unknown) => {
        callback(null, data as ToolApprovalEvent);
      });
    },
    updateToolApprovalSettings: async (
      teamName: string,
      settings: ToolApprovalSettings
    ): Promise<void> => {
      await this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tool-approval/settings`,
        settings
      );
    },
    readFileForToolApproval: async (filePath: string): Promise<ToolApprovalFileContent> => {
      return this.post<ToolApprovalFileContent>('/api/teams/tool-approval/read-file', { filePath });
    },
  };

  workers = {
    list: () => this.get<{ workers: DiscoverableWorker[] }>('/api/workers'),
    invoke: (
      workerId: string,
      request: {
        fromTeam?: string;
        text: string;
        summary?: string;
        sessionName?: string;
        reuse?: boolean;
        sessionKey?: string;
      }
    ) =>
      this.postLong<{
        ok: boolean;
        worker: DiscoverableWorker;
        session: CcSession;
        reused: boolean;
        messageSent: boolean;
      }>(`/api/workers/${encodeURIComponent(workerId)}/invoke`, request, 30_000),
  };

  // Review API
  review = {
    getAgentChanges: async (teamName: string, memberName: string) => {
      return this.get<AgentChangeSet>(
        `/api/teams/${encodeURIComponent(teamName)}/review/agent-changes/${encodeURIComponent(memberName)}`
      );
    },
    getTaskChanges: async (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
        stateBucket?: 'approved' | 'review' | 'completed' | 'active';
        summaryOnly?: boolean;
        forceFresh?: boolean;
      }
    ) => {
      const params = new URLSearchParams();
      if (options?.owner) params.set('owner', options.owner);
      if (options?.status) params.set('status', options.status);
      if (options?.since) params.set('since', options.since);
      if (options?.stateBucket) params.set('stateBucket', options.stateBucket);
      if (options?.summaryOnly) params.set('summaryOnly', 'true');
      if (options?.forceFresh) params.set('forceFresh', 'true');
      const qs = params.toString();
      const path = `/api/teams/${encodeURIComponent(teamName)}/review/task-changes/${encodeURIComponent(taskId)}`;
      return this.get<TaskChangeSetV2>(qs ? `${path}?${qs}` : path);
    },
    invalidateTaskChangeSummaries: async (): Promise<void> => {
      console.warn(
        '[HttpAPIClient] invalidateTaskChangeSummaries is not available in browser mode'
      );
    },
    getChangeStats: async (teamName: string, memberName: string) => {
      return this.get<ChangeStats>(
        `/api/teams/${encodeURIComponent(teamName)}/review/change-stats/${encodeURIComponent(memberName)}`
      );
    },
    getFileContent: async (
      teamName: string,
      memberName: string | undefined,
      filePath: string,
      _snippets: SnippetDiff[] = []
    ) => {
      const params = new URLSearchParams();
      params.set('filePath', filePath);
      if (memberName) params.set('memberName', memberName);
      return this.get<FileChangeWithContent>(
        `/api/teams/${encodeURIComponent(teamName)}/review/file-content?${params}`
      );
    },
    applyDecisions: async (request: ApplyReviewRequest) => {
      return this.post<ApplyReviewResult>(
        `/api/teams/${encodeURIComponent(request.teamName)}/review/apply-decisions`,
        request
      );
    },
    checkConflict: async (filePath: string, expectedModified: string) => {
      return this.post<ConflictCheckResult>('/api/teams/review/check-conflict', {
        filePath,
        expectedModified,
      });
    },
    rejectHunks: async (
      _filePath: string,
      _original: string,
      _modified: string,
      _hunkIndices: number[],
      _snippets: SnippetDiff[]
    ) => {
      // TeamName not in API interface; reject-hunks endpoint requires it in URL.
      // This is a limitation in browser mode — would need teamName tracking.
      throw new Error('Review reject hunks is not available in browser mode');
    },
    rejectFile: async (_filePath: string, _original: string, _modified: string) => {
      throw new Error('Review reject file is not available in browser mode');
    },
    previewReject: async (
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      snippets: SnippetDiff[]
    ) => {
      return this.post<{ preview: string; hasConflicts: boolean }>(
        '/api/teams/review/preview-reject',
        { filePath, original, modified, hunkIndices, snippets }
      );
    },
    saveEditedFile: async (filePath: string, content: string, projectPath?: string) => {
      return this.post<{ success: boolean }>('/api/teams/review/save-edited-file', {
        filePath,
        content,
        projectPath,
      });
    },
    watchFiles: async (): Promise<void> => {
      console.warn('[HttpAPIClient] Review file watching is not available in browser mode');
    },
    unwatchFiles: async (): Promise<void> => {
      console.warn('[HttpAPIClient] Review file watching is not available in browser mode');
    },
    onExternalFileChange: (): (() => void) => {
      return () => {};
    },
    loadDecisions: async (teamName: string, scopeKey: string, scopeToken?: string) => {
      return this.post<{
        hunkDecisions: Record<string, HunkDecision>;
        fileDecisions: Record<string, HunkDecision>;
        hunkContextHashesByFile?: Record<string, Record<number, string>>;
      } | null>('/api/teams/review/decisions/load', { teamName, scopeKey, scopeToken });
    },
    saveDecisions: async (
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      hunkDecisions: Record<string, HunkDecision>,
      fileDecisions: Record<string, HunkDecision>,
      hunkContextHashesByFile?: Record<string, Record<number, string>>
    ): Promise<void> => {
      await this.post('/api/teams/review/decisions/save', {
        teamName,
        scopeKey,
        scopeToken,
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile,
      });
    },
    clearDecisions: async (
      teamName: string,
      scopeKey: string,
      scopeToken?: string
    ): Promise<void> => {
      await this.post('/api/teams/review/decisions/clear', { teamName, scopeKey, scopeToken });
    },
    getGitFileLog: async (projectPath: string, filePath: string) => {
      const params = new URLSearchParams();
      params.set('projectPath', projectPath);
      params.set('filePath', filePath);
      return this.get<{ hash: string; timestamp: string; message: string }[]>(
        `/api/teams/review/git-file-log?${params}`
      );
    },
  };

  // ---------------------------------------------------------------------------
  // CLI Installer (not available in browser mode)
  // ---------------------------------------------------------------------------

  cliInstaller: CliInstallerAPI = {
    getStatus: async () => {
      try {
        const result = await this.get<{
          installed: boolean;
          version: string | null;
          path: string | null;
          authenticated: boolean;
        }>('/api/cli/status');

        // Fetch providers in parallel for Web mode
        const providerIds = ['anthropic', 'codex', 'gemini', 'opencode'] as const;
        const providerResults = await Promise.all(
          providerIds.map(async (providerId): Promise<CliProviderStatus | null> => {
            try {
              return await this.get<CliProviderStatus>(`/api/cli/provider/${providerId}/status`);
            } catch {
              return null;
            }
          })
        );
        // The cc-connect sidecar backend does not implement per-provider status
        // endpoints (they return an empty array), so drop any malformed entries
        // and only keep real provider objects.
        const validProviders = providerResults.filter(
          (p): p is CliProviderStatus =>
            p != null &&
            typeof p === 'object' &&
            !Array.isArray(p) &&
            typeof p.providerId === 'string'
        );

        // When the backend reports no provider capability data, fall back to a
        // sane Anthropic provider so extension management (plugins/MCP/skills)
        // is not falsely gated off. The backend remains the source of truth and
        // will reject an install if the runtime genuinely cannot perform it.
        const providers =
          validProviders.length > 0
            ? validProviders
            : [
                {
                  providerId: 'anthropic',
                  displayName: 'Anthropic',
                  supported: true,
                  authenticated: true,
                  authMethod: null,
                  verificationState: 'verified',
                  models: [],
                  canLoginFromUi: true,
                  capabilities: {
                    teamLaunch: true,
                    oneShot: true,
                    extensions: createDefaultCliExtensionCapabilities(),
                  },
                } satisfies CliProviderStatus,
              ];

        return {
          flavor: 'agent_teams_orchestrator',
          displayName: 'Agent CLI',
          supportsSelfUpdate: false,
          showVersionDetails: false,
          showBinaryPath: false,
          installed: result.installed,
          installedVersion: result.version,
          binaryPath: result.path,
          launchError: null,
          latestVersion: null,
          updateAvailable: false,
          authLoggedIn: result.authenticated ?? true,
          authStatusChecking: true,
          authMethod: null,
          providers,
        };
      } catch {
        return {
          flavor: 'agent_teams_orchestrator',
          displayName: 'Agent CLI',
          supportsSelfUpdate: false,
          showVersionDetails: false,
          showBinaryPath: false,
          installed: false,
          installedVersion: null,
          binaryPath: null,
          launchError: null,
          latestVersion: null,
          updateAvailable: false,
          authLoggedIn: false,
          authStatusChecking: false,
          authMethod: null,
          providers: [],
        };
      }
    },
    getProviderStatus: async (providerId: string): Promise<CliProviderStatus | null> => {
      try {
        const result = await this.get<unknown>(
          `/api/cli/provider/${encodeURIComponent(providerId)}/status`
        );
        // The cc-connect sidecar returns an empty array for unimplemented
        // provider endpoints. Treat any malformed payload as "no data" (null)
        // so it does not overwrite the synthesized provider in getStatus().
        if (
          result == null ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          typeof (result as CliProviderStatus).providerId !== 'string'
        ) {
          return null;
        }
        return result as CliProviderStatus;
      } catch {
        return null;
      }
    },
    verifyProviderModels: async (): Promise<null> => null,
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] CLI installer not available in browser mode');
    },
    invalidateStatus: async (): Promise<void> => {
      try {
        await this.post('/api/cli/invalidate-status');
      } catch {
        /* ignore */
      }
    },
    onProgress: (): (() => void) => {
      return () => {};
    },
  };

  systemReadiness = {
    /** Fetch runtime readiness (cc-connect binary + sidecar health) for the degraded banner. */
    getStatus: async (): Promise<RuntimeReadiness> => {
      const res = await this.get<{ ok: boolean; data: RuntimeReadiness }>(
        '/api/v1/system/readiness'
      );
      return res.data;
    },
  };

  // ---------------------------------------------------------------------------
  // Extensions (plugins, MCP registry, skills — HTTP API)
  // ---------------------------------------------------------------------------

  plugins = {
    getAll: async (projectPath?: string, forceRefresh?: boolean) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      if (forceRefresh) params.set('forceRefresh', 'true');
      const qs = params.toString();
      const result = await this.get<{ success: boolean; data?: EnrichedPlugin[]; error?: string }>(
        `/api/extensions/plugins${qs ? `?${qs}` : ''}`,
        // Catalog assembly scans local installs + remote registries (GitHub),
        // which routinely exceeds the default 10s — match the team-endpoint
        // 30s budget so the Extensions store doesn't time out on first open.
        30_000
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to get plugins');
      return result.data ?? [];
    },
    getReadme: async (pluginId: string) => {
      const result = await this.get<{ success: boolean; data?: string | null; error?: string }>(
        `/api/extensions/plugins/${encodeURIComponent(pluginId)}/readme`,
        30_000
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to get readme');
      return result.data ?? null;
    },
    install: async (request: PluginInstallRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: OperationResult;
        error?: string;
      }>('/api/extensions/plugins/install', request);
      if (!result.success) return { state: 'error' as const, error: result.error };
      return result.data!;
    },
    uninstall: async (pluginId: string, scope?: string, projectPath?: string) => {
      const result = await this.post<{
        success: boolean;
        data?: OperationResult;
        error?: string;
      }>('/api/extensions/plugins/uninstall', { pluginId, scope, projectPath });
      if (!result.success) return { state: 'error' as const, error: result.error };
      return result.data!;
    },
  };

  mcpRegistry = {
    search: async (query: string, limit?: number) => {
      const params = new URLSearchParams({ q: query });
      if (limit) params.set('limit', String(limit));
      const result = await this.get<{
        success: boolean;
        data?: McpSearchResult;
        error?: string;
      }>(`/api/extensions/mcp/search?${params}`);
      if (!result.success) {
        return { servers: [], total: 0, warnings: [result.error ?? 'Search failed'] };
      }
      return result.data!;
    },
    browse: async (cursor?: string, limit?: number) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const result = await this.get<{
        success: boolean;
        data?: { servers: McpCatalogItem[]; nextCursor?: string };
        error?: string;
      }>(`/api/extensions/mcp/browse${qs ? `?${qs}` : ''}`);
      if (!result.success) return { servers: [] };
      return result.data!;
    },
    getById: async (registryId: string) => {
      const result = await this.get<{
        success: boolean;
        data?: McpCatalogItem | null;
        error?: string;
      }>(`/api/extensions/mcp/${encodeURIComponent(registryId)}`);
      if (!result.success) return null;
      return result.data ?? null;
    },
    getInstalled: async (projectPath?: string) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const qs = params.toString();
      const result = await this.get<{
        success: boolean;
        data?: InstalledMcpEntry[];
        error?: string;
      }>(`/api/extensions/mcp/installed${qs ? `?${qs}` : ''}`);
      if (!result.success) return [];
      return result.data ?? [];
    },
    diagnose: async (projectPath?: string) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const qs = params.toString();
      const result = await this.get<{
        success: boolean;
        data?: McpServerDiagnostic[];
        error?: string;
      }>(`/api/extensions/mcp/diagnose${qs ? `?${qs}` : ''}`);
      if (!result.success) return [];
      return result.data ?? [];
    },
    install: async (request: McpInstallRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: OperationResult;
        error?: string;
      }>('/api/extensions/mcp/install', request);
      if (!result.success) return { state: 'error' as const, error: result.error };
      return result.data!;
    },
    installCustom: async (request: McpCustomInstallRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: OperationResult;
        error?: string;
      }>('/api/extensions/mcp/install-custom', request);
      if (!result.success) return { state: 'error' as const, error: result.error };
      return result.data!;
    },
    uninstall: async (name: string, scope?: string, projectPath?: string) => {
      const result = await this.post<{
        success: boolean;
        data?: OperationResult;
        error?: string;
      }>('/api/extensions/mcp/uninstall', { name, scope, projectPath });
      if (!result.success) return { state: 'error' as const, error: result.error };
      return result.data!;
    },
    githubStars: async (repositoryUrls: string[]) => {
      const result = await this.post<{
        success: boolean;
        data?: Record<string, number>;
        error?: string;
      }>('/api/extensions/mcp/github-stars', { repositoryUrls });
      if (!result.success) return {};
      return result.data ?? {};
    },
    libraryList: async () => {
      const result = await this.get<{
        success: boolean;
        data?: McpLibraryEntry[];
        error?: string;
      }>('/api/extensions/mcp/library');
      if (!result.success) return [];
      return result.data ?? [];
    },
    libraryUpsert: async (request: McpLibraryUpsertRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: McpLibraryEntry;
        error?: string;
      }>('/api/extensions/mcp/library', request);
      if (!result.success || !result.data) throw new Error(result.error ?? 'Save failed');
      return result.data;
    },
    libraryDelete: async (id: string) => {
      const result = await this.delete<{ success: boolean; error?: string }>(
        `/api/extensions/mcp/library/${encodeURIComponent(id)}`
      );
      if (!result.success) throw new Error(result.error ?? 'Delete failed');
    },
    libraryImport: async (request: McpLibraryImportRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: McpLibraryImportResult;
        error?: string;
      }>('/api/extensions/mcp/library/import', request);
      if (!result.success) throw new Error(result.error ?? 'Import failed');
      return result.data ?? { imported: [], skipped: [] };
    },
  };

  capabilityPacks = {
    list: async () => {
      const result = await this.get<{
        success: boolean;
        data?: CapabilityPackListResult;
        error?: string;
      }>('/api/extensions/capability-packs');
      if (!result.success)
        return { packs: [], warnings: result.error ? [result.error] : [], rootDir: '' };
      return result.data ?? { packs: [], warnings: [], rootDir: '' };
    },
    importPack: async (request: CapabilityPackImportRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: CapabilityPackMutationResult;
        error?: string;
      }>('/api/extensions/capability-packs/import', request);
      if (!result.success) throw new Error(result.error ?? 'Import capability pack failed');
      return result.data ?? { pack: null, warnings: [] };
    },
    exportPack: async (request: CapabilityPackExportRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: CapabilityPackMutationResult;
        error?: string;
      }>('/api/extensions/capability-packs/export', request);
      if (!result.success) throw new Error(result.error ?? 'Export capability pack failed');
      return result.data ?? { pack: null, warnings: [] };
    },
    getCommandPrompt: async (request: CapabilityCommandPromptRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: CapabilityCommandPromptResult;
        error?: string;
      }>('/api/extensions/capability-packs/command-prompt', request);
      if (!result.success) throw new Error(result.error ?? 'Load capability command failed');
      if (!result.data) throw new Error('Load capability command failed');
      return result.data;
    },
  };

  skills = {
    list: async (projectPath?: string) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const qs = params.toString();
      const result = await this.get<{
        success: boolean;
        data?: SkillCatalogItem[];
        error?: string;
      }>(`/api/extensions/skills${qs ? `?${qs}` : ''}`);
      if (!result.success) return [];
      return result.data ?? [];
    },
    getDetail: async (skillId: string, projectPath?: string) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const qs = params.toString();
      const result = await this.get<{
        success: boolean;
        data?: SkillDetail | null;
        error?: string;
      }>(`/api/extensions/skills/${encodeURIComponent(skillId)}${qs ? `?${qs}` : ''}`);
      if (!result.success) return null;
      return result.data ?? null;
    },
    previewUpsert: async (request: SkillUpsertRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: SkillReviewPreview;
        error?: string;
      }>('/api/extensions/skills/preview-upsert', request);
      if (!result.success) throw new Error(result.error ?? 'Preview failed');
      return result.data!;
    },
    applyUpsert: async (request: SkillUpsertRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: SkillDetail | null;
        error?: string;
      }>('/api/extensions/skills/apply-upsert', request);
      if (!result.success) throw new Error(result.error ?? 'Apply failed');
      return result.data ?? null;
    },
    previewImport: async (request: SkillImportRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: SkillReviewPreview;
        error?: string;
      }>('/api/extensions/skills/preview-import', request);
      if (!result.success) throw new Error(result.error ?? 'Preview import failed');
      return result.data!;
    },
    applyImport: async (request: SkillImportRequest) => {
      const result = await this.post<{
        success: boolean;
        data?: SkillDetail | null;
        error?: string;
      }>('/api/extensions/skills/apply-import', request);
      if (!result.success) throw new Error(result.error ?? 'Apply import failed');
      return result.data ?? null;
    },
    deleteSkill: async (request: SkillDeleteRequest) => {
      const result = await this.post<{ success: boolean; error?: string }>(
        '/api/extensions/skills/delete',
        request
      );
      if (!result.success) throw new Error(result.error ?? 'Delete failed');
    },
    listSources: async () => {
      const result = await this.get<{
        success: boolean;
        data?: SkillSourcesSnapshot;
        error?: string;
      }>('/api/extensions/skills/sources');
      if (!result.success) return { sources: [] };
      return result.data ?? { sources: [] };
    },
    saveSources: async (sources: SkillSource[]) => {
      const result = await this.postLong<{
        success: boolean;
        data?: SkillSourcesSnapshot;
        error?: string;
      }>('/api/extensions/skills/sources/save', sources);
      if (!result.success) throw new Error(result.error ?? 'Save failed');
      return result.data ?? { sources: [] };
    },
    refreshSources: async () => {
      const result = await this.postLong<{
        success: boolean;
        data?: SkillSourcesSnapshot;
        error?: string;
      }>('/api/extensions/skills/sources/refresh');
      if (!result.success) throw new Error(result.error ?? 'Refresh failed');
      return result.data ?? { sources: [] };
    },
    startWatching: async (projectPath?: string) => {
      const params = new URLSearchParams();
      if (projectPath) params.set('projectPath', projectPath);
      const qs = params.toString();
      const result = await this.post<{ success: boolean; data?: string; error?: string }>(
        `/api/extensions/skills/watching/start${qs ? `?${qs}` : ''}`
      );
      if (!result.success) return '';
      return result.data ?? '';
    },
    stopWatching: async (watchId: string) => {
      const result = await this.post<{ success: boolean; error?: string }>(
        '/api/extensions/skills/watching/stop',
        { watchId }
      );
      if (!result.success) throw new Error(result.error ?? 'Stop watching failed');
    },
    onChanged: (callback: (event: SkillWatcherEvent) => void): (() => void) =>
      this.addEventListener('skills:changed', (data: unknown) =>
        callback(data as SkillWatcherEvent)
      ),
  };

  // ---------------------------------------------------------------------------
  // System Manager / Control Console
  // ---------------------------------------------------------------------------

  systemManager: SystemManagerAPI = {
    getDiagnosticsRuntime: async (refresh = false) => {
      return this.get(`/api/system-manager/diagnostics/runtime${refresh ? '?refresh=1' : ''}`);
    },
    getStatus: () => this.get('/api/system-manager/status'),
    getConfig: () => this.get('/api/system-manager/config'),
    updateConfig: (patch) => this.put('/api/system-manager/config', patch),
    listWorkflowPrompts: (folder) => this.post('/api/system-manager/workflows/list', { folder }),
    readWorkflowPrompt: (folder, id) =>
      this.post('/api/system-manager/workflows/read', { folder, id }),
  };

  // ---------------------------------------------------------------------------
  // Terminal (system/default terminal)
  // ---------------------------------------------------------------------------

  terminal: TerminalAPI = {
    openExternal: async (options: {
      command: string;
      args?: string[];
      cwd?: string;
    }): Promise<void> => {
      await this.post('/api/terminal/open-external', options);
    },
  };

  // ---------------------------------------------------------------------------
  // Direct CLI — open a system terminal resuming a team member or IM session
  // ---------------------------------------------------------------------------

  directCli = {
    resumeInTerminal: async (options: {
      teamName?: string;
      memberName?: string;
      agentSessionId?: string;
      cwd?: string;
    }): Promise<void> => {
      await this.post('/api/direct-cli/resume-in-terminal', options);
    },
  };

  // ---------------------------------------------------------------------------
  // Project (browser mode — delegates to HTTP)
  // ---------------------------------------------------------------------------

  project: ProjectAPI = {
    listFiles: async (projectPath: string) => {
      const params = new URLSearchParams({ root: projectPath });
      return this.get(`/api/editor/listFiles?${params}`);
    },
  };

  // ---------------------------------------------------------------------------
  // Credentials (project env, MCP credentials)
  // ---------------------------------------------------------------------------

  credentials = {
    getStatus: async () =>
      this.get<{ encryption: string; storagePath: string } | null>(
        '/api/extensions/credentials/status'
      ),

    getProjectEnv: async (projectPath: string) =>
      this.get<Record<string, string>>(
        `/api/extensions/credentials/project-env?projectPath=${encodeURIComponent(projectPath)}`
      ),

    saveProjectEnv: async (projectPath: string, vars: Record<string, string>): Promise<void> => {
      await this.post('/api/extensions/credentials/project-env', { projectPath, vars });
    },

    scanRequired: async (
      projectPath: string,
      mcpServers: {
        name: string;
        envVars?: { name: string; isRequired: boolean; description?: string };
      }[],
      skillReqs: {
        name: string;
        envVars: { name: string; isRequired?: boolean; description?: string }[];
      }[]
    ) =>
      this.post<{
        required: {
          name: string;
          isRequired: boolean;
          description?: string;
          source: string;
          value?: string;
        }[];
      }>('/api/extensions/credentials/scan-required', { projectPath, mcpServers, skillReqs }),

    resolveAgentEnv: async (projectPath: string) =>
      this.get<Record<string, string>>(
        `/api/extensions/credentials/resolve-agent-env?projectPath=${encodeURIComponent(projectPath)}`
      ),

    getSkillGlobalEnv: async (skillFolderName: string) =>
      this.get<Record<string, string>>(
        `/api/extensions/credentials/skill-env?folderName=${encodeURIComponent(skillFolderName)}`
      ),

    saveSkillGlobalEnv: async (
      skillFolderName: string,
      vars: Record<string, string>
    ): Promise<void> => {
      await this.post('/api/extensions/credentials/skill-env', {
        folderName: skillFolderName,
        vars,
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Workspace (file system browsing)
  // ---------------------------------------------------------------------------

  workspace = {
    list: async (dirPath: string): Promise<WorkspaceListResponse> =>
      this.post('/api/workspace/list', { dirPath }),
  };

  // ---------------------------------------------------------------------------
  // Editor (browser mode — delegates to HTTP)
  // ---------------------------------------------------------------------------

  private _editorRoot: string | null = null;

  editor: EditorAPI = {
    open: async (projectPath: string) => {
      this._editorRoot = projectPath;
    },
    close: async () => {
      this._editorRoot = null;
    },
    readDir: async (dirPath: string, maxEntries?: number) => {
      const params = new URLSearchParams({ root: this._editorRoot!, dirPath });
      if (maxEntries) params.set('maxEntries', String(maxEntries));
      return this.get(`/api/editor/readDir?${params}`);
    },
    readFile: async (filePath: string) => {
      const params = new URLSearchParams({ root: this._editorRoot!, filePath });
      return this.get(`/api/editor/readFile?${params}`);
    },
    writeFile: async (filePath: string, content: string, baselineMtimeMs?: number) => {
      return this.post('/api/editor/writeFile', {
        root: this._editorRoot,
        filePath,
        content,
        baselineMtimeMs,
      });
    },
    createFile: async (parentDir: string, fileName: string) => {
      return this.post('/api/editor/createFile', {
        root: this._editorRoot,
        parentDir,
        fileName,
      });
    },
    createDir: async (parentDir: string, dirName: string) => {
      return this.post('/api/editor/createDir', {
        root: this._editorRoot,
        parentDir,
        dirName,
      });
    },
    deleteFile: async (filePath: string) => {
      return this.post('/api/editor/deleteFile', {
        root: this._editorRoot,
        filePath,
      });
    },
    moveFile: async (sourcePath: string, destDir: string) => {
      return this.post('/api/editor/moveFile', {
        root: this._editorRoot,
        sourcePath,
        destDir,
      });
    },
    renameFile: async (sourcePath: string, newName: string) => {
      return this.post('/api/editor/renameFile', {
        root: this._editorRoot,
        sourcePath,
        newName,
      });
    },
    searchInFiles: async (options) => {
      const params = new URLSearchParams({ root: this._editorRoot!, query: options.query });
      if (options.caseSensitive) params.set('caseSensitive', 'true');
      if (options.maxFiles) params.set('maxFiles', String(options.maxFiles));
      if (options.maxMatches) params.set('maxMatches', String(options.maxMatches));
      return this.get(`/api/editor/search?${params}`);
    },
    listFiles: async () => {
      const params = new URLSearchParams({ root: this._editorRoot! });
      return this.get(`/api/editor/listFiles?${params}`);
    },
    readBinaryPreview: async (filePath: string) => {
      const params = new URLSearchParams({ root: this._editorRoot!, filePath });
      return this.get(`/api/editor/readBinaryPreview?${params}`);
    },
    gitStatus: async () => {
      const params = new URLSearchParams({ root: this._editorRoot! });
      return this.get(`/api/editor/gitStatus?${params}`);
    },
    watchDir: async (): Promise<void> => {
      // File watching not supported in browser mode
    },
    setWatchedFiles: async (): Promise<void> => {
      // File watching not supported in browser mode
    },
    setWatchedDirs: async (): Promise<void> => {
      // File watching not supported in browser mode
    },
    onEditorChange: () => {
      return () => {};
    },
  };

  schedules: ElectronAPI['schedules'] = {
    list: (): Promise<Schedule[]> => this.get<Schedule[]>('/api/schedules'),
    get: (id: string): Promise<Schedule | null> =>
      this.get<Schedule | null>(`/api/schedules/${encodeURIComponent(id)}`),
    create: (input: CreateScheduleInput): Promise<Schedule> =>
      this.post<Schedule>('/api/schedules', input),
    update: (id: string, patch: UpdateSchedulePatch): Promise<Schedule> =>
      this.patch<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, patch),
    delete: (id: string): Promise<void> => this.del(`/api/schedules/${encodeURIComponent(id)}`),
    pause: (id: string): Promise<void> =>
      this.post(`/api/schedules/${encodeURIComponent(id)}/pause`),
    resume: (id: string): Promise<void> =>
      this.post(`/api/schedules/${encodeURIComponent(id)}/resume`),
    triggerNow: (id: string): Promise<ScheduleRun> =>
      this.post<ScheduleRun>(`/api/schedules/${encodeURIComponent(id)}/trigger`),
    getRuns: (
      scheduleId: string,
      opts?: { limit?: number; offset?: number }
    ): Promise<ScheduleRun[]> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.offset) params.set('offset', String(opts.offset));
      const qs = params.toString();
      const base = `/api/schedules/${encodeURIComponent(scheduleId)}/runs`;
      return this.get<ScheduleRun[]>(qs ? `${base}?${qs}` : base);
    },
    getRunLogs: (scheduleId: string, runId: string): Promise<{ stdout: string; stderr: string }> =>
      this.get<{ stdout: string; stderr: string }>(
        `/api/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/logs`
      ),
    onScheduleChange: (
      callback: (event: unknown, data: ScheduleChangeEvent) => void
    ): (() => void) =>
      this.addEventListener('schedule:change', (data: unknown) =>
        callback(null, data as ScheduleChangeEvent)
      ),
  };

  getPathForFile = (_file: File): string => '';
}

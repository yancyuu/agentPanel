/**
 * HermitBridgeClient — HTTP client for hermit-bridge Management API.
 *
 * Wraps all /api/v1/* endpoints needed by Hermit's team management layer.
 * Default target: http://127.0.0.1:9820
 */

import { HERMIT_BRIDGE_DEFAULTS } from '@shared/types/hermitBridge';
import { createLogger } from '@shared/utils/logger';

import type {
  HermitBridgeAddPlatformRequest,
  HermitBridgeApiResponse,
  HermitBridgeConnectionConfig,
  HermitBridgeCreateCronJobRequest,
  HermitBridgeCronJob,
  HermitBridgeGlobalProvider,
  HermitBridgeHeartbeatStatus,
  HermitBridgeModelEntry,
  HermitBridgeProjectDetail,
  HermitBridgeProjectListItem,
  HermitBridgeProjectSettingsUpdate,
  HermitBridgeProviderPresetsResponse,
  HermitBridgeSessionDetail,
  HermitBridgeSessionListItem,
  HermitBridgeStatus,
} from '@shared/types/hermitBridge';

const logger = createLogger('HermitBridgeClient');

export class HermitBridgeClient {
  private baseUrl: string;
  private token: string;
  private readonly timeoutMs: number;

  constructor(config?: Partial<HermitBridgeConnectionConfig>) {
    this.baseUrl = (
      config?.baseUrl ??
      process.env.HERMIT_BRIDGE_BASE_URL ??
      process.env.CC_CONNECT_BASE_URL ??
      HERMIT_BRIDGE_DEFAULTS.baseUrl
    ).replace(/\/+$/, '');
    this.token = (
      config?.token ??
      process.env.HERMIT_BRIDGE_TOKEN ??
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ??
      process.env.CC_CONNECT_TOKEN ??
      process.env.CC_CONNECT_MANAGEMENT_TOKEN ??
      ''
    ).trim();
    this.timeoutMs = 15_000;
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!text.trim()) {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return undefined as T;
      }

      let json: HermitBridgeApiResponse<T>;
      try {
        json = JSON.parse(text) as HermitBridgeApiResponse<T>;
      } catch {
        throw new Error(`hermit-bridge returned non-JSON: ${text.slice(0, 200)}`);
      }

      if (!response.ok || json.ok === false) {
        throw new Error(json.error ?? `HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      return (json.data ?? json) as T;
    } catch (err) {
      // undici's TypeError('fetch failed') carries the real reason on `cause`
      // (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, ECONNRESET, …). Without this,
      // a transport fault surfaces as a bare "fetch failed" / ccSyncError with
      // no clue why — mirroring the OpenHermitAuthClient.fetchErrorMessage rule.
      if (err instanceof Error && err.message === 'fetch failed') {
        const cause = (err as { cause?: { code?: string; errno?: string; message?: string } })
          .cause;
        const detail =
          cause?.code ||
          cause?.errno ||
          (cause?.message ? String(cause.message).split('\n')[0] : '');
        throw new Error(detail ? `fetch failed (${detail})` : 'fetch failed', { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  async getStatus(): Promise<HermitBridgeStatus> {
    return this.request<HermitBridgeStatus>('GET', '/api/v1/status');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Projects
  // ===========================================================================

  async listProjects(): Promise<HermitBridgeProjectListItem[]> {
    const data = await this.request<{ projects: HermitBridgeProjectListItem[] }>(
      'GET',
      '/api/v1/projects'
    );
    return data.projects ?? [];
  }

  async getProject(name: string): Promise<HermitBridgeProjectDetail> {
    return this.request<HermitBridgeProjectDetail>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(name)}`
    );
  }

  async updateProject(
    name: string,
    settings: HermitBridgeProjectSettingsUpdate
  ): Promise<{ message: string; restart_required: boolean }> {
    return this.request('PATCH', `/api/v1/projects/${encodeURIComponent(name)}`, settings);
  }

  async deleteProject(name: string): Promise<{ message: string; restart_required: boolean }> {
    return this.request('DELETE', `/api/v1/projects/${encodeURIComponent(name)}`);
  }

  /**
   * Stop a project: delete it from hermit-bridge and restart to activate changes.
   * This effectively stops all sessions and agents for the project.
   */
  async stopProject(name: string): Promise<void> {
    try {
      const result = await this.deleteProject(name);
      if (result.restart_required) {
        await this.restart();
      }
      logger.info(`hermit-bridge project "${name}" stopped`);
    } catch (err) {
      // Project might already not exist — log but don't throw
      logger.warn(
        `Failed to stop project "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Create a new project by adding a platform.
   * If the project doesn't exist, hermit-bridge creates it automatically.
   * Requires a restart afterwards for the new engine to start.
   */
  async createProject(
    name: string,
    agentType: string,
    workDir: string,
    platformType: string = 'bridge',
    platformOptions: Record<string, string> = {}
  ): Promise<{ message: string; restart_required: boolean }> {
    const body: HermitBridgeAddPlatformRequest = {
      type: platformType,
      options: platformOptions,
      work_dir: workDir,
      agent_type: agentType,
    };
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(name)}/add-platform`, body);
  }

  // ===========================================================================
  // Restart / Reload
  // ===========================================================================

  async restart(): Promise<void> {
    await this.request('POST', '/api/v1/restart', {});
    logger.info('hermit-bridge restart triggered');
  }

  async reload(): Promise<void> {
    await this.request('POST', '/api/v1/reload', {});
  }

  /**
   * Create project and restart hermit-bridge to activate it.
   * Convenience wrapper around createProject + restart.
   */
  async createProjectAndStart(
    name: string,
    agentType: string,
    workDir: string,
    platformType: string = 'bridge',
    platformOptions: Record<string, string> = {}
  ): Promise<void> {
    const result = await this.createProject(
      name,
      agentType,
      workDir,
      platformType,
      platformOptions
    );
    if (result.restart_required) {
      await this.restart();
    }
  }

  // ===========================================================================
  // Messages
  // ===========================================================================

  async sendMessage(projectName: string, sessionKey: string, message: string): Promise<void> {
    await this.request('POST', `/api/v1/projects/${encodeURIComponent(projectName)}/send`, {
      session_key: sessionKey,
      message,
    });
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  async listSessions(projectName: string): Promise<HermitBridgeSessionListItem[]> {
    const data = await this.request<{ sessions: HermitBridgeSessionListItem[] }>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectName)}/sessions`
    );
    return data.sessions ?? [];
  }

  async getSession(
    projectName: string,
    sessionId: string,
    historyLimit: number = 500
  ): Promise<HermitBridgeSessionDetail> {
    return this.request<HermitBridgeSessionDetail>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}?history_limit=${historyLimit}`
    );
  }

  async createSession(
    projectName: string,
    name?: string,
    sessionKey?: string
  ): Promise<HermitBridgeSessionDetail> {
    const body: Record<string, string> = {};
    if (name) body.name = name;
    if (sessionKey) body.session_key = sessionKey;
    return this.request<HermitBridgeSessionDetail>(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectName)}/sessions`,
      body
    );
  }

  async deleteSession(projectName: string, sessionId: string): Promise<void> {
    await this.request(
      'DELETE',
      `/api/v1/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  async getHeartbeat(projectName: string): Promise<HermitBridgeHeartbeatStatus> {
    return this.request<HermitBridgeHeartbeatStatus>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectName)}/heartbeat`
    );
  }

  async pauseHeartbeat(projectName: string): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectName)}/heartbeat/pause`,
      {}
    );
  }

  async resumeHeartbeat(projectName: string): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectName)}/heartbeat/resume`,
      {}
    );
  }

  // ===========================================================================
  // Providers
  // ===========================================================================

  async listProviders(): Promise<HermitBridgeGlobalProvider[]> {
    const data = await this.request<{ providers: HermitBridgeGlobalProvider[] }>(
      'GET',
      '/api/v1/providers'
    );
    return data.providers ?? [];
  }

  async getProviderPresets(): Promise<HermitBridgeProviderPresetsResponse> {
    return this.request<HermitBridgeProviderPresetsResponse>('GET', '/api/v1/providers/presets');
  }

  async addProvider(
    provider: HermitBridgeGlobalProvider
  ): Promise<{ name: string; message: string }> {
    return this.request('POST', '/api/v1/providers', provider);
  }

  async updateProvider(
    name: string,
    patch: Partial<HermitBridgeGlobalProvider>
  ): Promise<{ message: string }> {
    return this.request('PUT', `/api/v1/providers/${encodeURIComponent(name)}`, patch);
  }

  async deleteProvider(name: string): Promise<{ message: string }> {
    return this.request('DELETE', `/api/v1/providers/${encodeURIComponent(name)}`);
  }

  // ===========================================================================
  // Models
  // ===========================================================================

  async listModels(projectName: string): Promise<HermitBridgeModelEntry[]> {
    const data = await this.request<{ models: HermitBridgeModelEntry[] }>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectName)}/models`
    );
    return data.models ?? [];
  }

  // ===========================================================================
  // Provider References (per-project)
  // ===========================================================================

  async getProviderRefs(projectName: string): Promise<string[]> {
    const data = await this.request<{ provider_refs: string[] }>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectName)}/provider-refs`
    );
    return data.provider_refs ?? [];
  }

  async setProviderRefs(projectName: string, providerRefs: string[]): Promise<void> {
    await this.request('PUT', `/api/v1/projects/${encodeURIComponent(projectName)}/provider-refs`, {
      provider_refs: providerRefs,
    });
  }

  // ===========================================================================
  // Global settings
  // ===========================================================================

  async getGlobalSettings(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/api/v1/settings');
  }

  async patchGlobalSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PATCH', '/api/v1/settings', patch);
  }

  // ===========================================================================
  // Cron jobs
  // ===========================================================================

  async listCronJobs(): Promise<HermitBridgeCronJob[]> {
    const data = await this.request<{ jobs: HermitBridgeCronJob[] }>('GET', '/api/v1/cron');
    return data.jobs ?? [];
  }

  async createCronJob(input: HermitBridgeCreateCronJobRequest): Promise<HermitBridgeCronJob> {
    return this.request<HermitBridgeCronJob>('POST', '/api/v1/cron', input);
  }

  async updateCronJob(
    id: string,
    patch: Partial<HermitBridgeCreateCronJobRequest> & { enabled?: boolean }
  ): Promise<HermitBridgeCronJob> {
    return this.request<HermitBridgeCronJob>(
      'PATCH',
      `/api/v1/cron/${encodeURIComponent(id)}`,
      patch
    );
  }

  async deleteCronJob(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/cron/${encodeURIComponent(id)}`);
  }

  // ===========================================================================
  // Configuration update
  // ===========================================================================

  updateConfig(config: Partial<HermitBridgeConnectionConfig>): void {
    if (config.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    }
    if (config.token !== undefined) {
      this.token = config.token.trim();
    }
  }
}

/**
 * Direct-CLI execution layer for in-app Loop sessions and team-member DMs.
 *
 * Hermit spawns the local `claude` CLI directly as a long-lived stream-json subprocess
 * (one per session key), bypassing the cc-connect sidecar entirely for these surfaces.
 * cc-connect stays in charge of external IM (Feishu/WeChat). Running claude directly in
 * the work_dir removes the project/work_dir/platform misconfiguration that surfaced as
 * "❌ 错误: 启动 Agent 会话失败".
 *
 * Each subprocess writes the standard `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, so
 * the existing tool-activity / chunk / context views (LocalSessionScanner) keep working
 * with no changes. We only relay the live stream over SSE for token-level display.
 */

import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import { classifyClaudeStreamLine, type ClaudeStreamLine } from '@shared/utils/claudeStreamJson';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import { type DirectCliSessionRepository, DirectCliSessionStore } from './DirectCliSessionStore';

import type { AttachmentPayload } from '@shared/types';
import type { ChildProcess, SpawnOptions } from 'child_process';

/** Args mirror the cc-connect claudecode invocation that this replaces. */
export interface ClaudeStreamArgsOptions {
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  verbose?: boolean;
  /** Provider-resolved args (model, effort, flags) from buildProviderAwareCliEnv. */
  providerArgs?: string[];
}

/**
 * Build the argv for `claude --output-format stream-json ...`. Pure + tested separately
 * so the spawn wiring never needs to launch a real process to verify its flags.
 */
export function buildClaudeStreamArgs(options: ClaudeStreamArgsOptions = {}): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
  ];
  // --verbose makes claude flush assistant events as they stream (granular deltas). It only
  // conflicts with --output-format stream-json when a router_url is set, which we never do.
  if (options.verbose !== false) args.push('--verbose');
  if (options.resumeSessionId?.trim()) {
    args.push('--resume', options.resumeSessionId.trim());
  }
  if (options.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', options.appendSystemPrompt.trim());
  }
  if (options.providerArgs?.length) {
    args.push(...options.providerArgs);
  }
  return args;
}

/**
 * Format a user turn as the NDJSON line claude's stream-json stdin expects.
 * Mirrors what cc-connect writes to the harness stdin.
 */
function attachmentToContentBlock(attachment: AttachmentPayload): Record<string, unknown> | null {
  if (!attachment.data) return null;

  if (attachment.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType,
        data: attachment.data,
      },
    };
  }

  if (attachment.mimeType === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: attachment.data,
      },
    };
  }

  if (attachment.mimeType === 'text/plain') {
    const decoded = Buffer.from(attachment.data, 'base64').toString('utf8');
    return {
      type: 'text',
      text: `\n\n[Attachment: ${attachment.filename}]\n${decoded}`,
    };
  }

  return null;
}

export function formatClaudeStdinUserTurn(
  text: string,
  attachments: AttachmentPayload[] = []
): string {
  const content = [
    { type: 'text', text },
    ...attachments
      .map(attachmentToContentBlock)
      .filter((block): block is Record<string, unknown> => block !== null),
  ];

  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }) + '\n'
  );
}

export interface DirectCliSpawnParams {
  sessionKey: string;
  workDir: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  model?: string | null;
  providerId?: string;
  providerBackendId?: string | null;
  teamSlug?: string;
  workbenchUrl?: string;
  verbose?: boolean;
}

export interface DirectCliSendParams {
  text: string;
  attachments?: AttachmentPayload[];
  /** Optimistic id used to route stream deltas to the right in-progress message. */
  messageId: string;
  /** cwd used to (lazily) spawn the subprocess if the session doesn't exist yet. */
  workDir: string;
  teamSlug?: string;
  workbenchUrl?: string;
}

export type OneShotHarness = 'codex' | 'pi';

export interface DirectCliOneShotParams extends DirectCliSendParams {
  harness: OneShotHarness;
}

export type DirectCliEvent =
  | { kind: 'init'; sessionKey: string; sessionId: string; model?: string }
  | { kind: 'delta'; sessionKey: string; messageId: string; text: string }
  | { kind: 'thinking'; sessionKey: string; messageId: string; text: string }
  | { kind: 'tool'; sessionKey: string; messageId: string; toolName: string; toolInput: unknown }
  | {
      kind: 'complete';
      sessionKey: string;
      messageId: string;
      text: string;
      sessionId?: string;
    }
  | {
      kind: 'permission-request';
      sessionKey: string;
      /** Stable per-spawn id; changes when the subprocess is respawned so stale approvals
       *  can be dismissed by runId after a stop→launch race. */
      runId: string;
      requestId: string;
      subtype?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
    }
  | { kind: 'error'; sessionKey: string; messageId?: string; error: string };

interface OneShotSessionHandle {
  child: ChildProcess;
  messageId: string;
}

interface CliSessionHandle {
  child: ChildProcess;
  sessionId?: string;
  /** Per-spawn id threaded onto permission-request events so stale approvals are
   *  dismissible after a respawn. */
  runId: string;
  activeMessageId?: string;
  /** Accumulated assistant text for the in-flight turn (fallback if result has none). */
  accumulatedText: string;
  /** Half-finished stdout line pending a newline. */
  stdoutBuffer: string;
  /** True after the process exited; guards against writing to a dead stdin. */
  closed: boolean;
}

/** Spawn function signature (mockable in tests). */
export type DirectCliSpawnFn = (
  binaryPath: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

/** Provider env resolver (mockable in tests). */
export type DirectCliEnvResolver = (params: {
  binaryPath: string | null;
  providerId?: string;
  providerBackendId?: string | null;
  model?: string | null;
  projectPath?: string;
}) => Promise<{ env: NodeJS.ProcessEnv; providerArgs: string[] }>;

export type OneShotBinaryResolver = (
  harness: OneShotHarness,
  env?: NodeJS.ProcessEnv
) => Promise<string | null>;

export interface DirectCliSessionManagerOptions {
  spawnFn?: DirectCliSpawnFn;
  envResolver?: DirectCliEnvResolver;
  binaryResolver?: typeof ClaudeBinaryResolver;
  oneShotBinaryResolver?: OneShotBinaryResolver;
  store?: DirectCliSessionRepository;
}

const ONE_SHOT_OUTPUT_LIMIT = 4 * 1024 * 1024;

function resolveFromPath(binaryName: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where' : 'which',
      [binaryName],
      { timeout: 5_000, env: env ?? process.env },
      (error, stdout) => resolve(error || !stdout.trim() ? null : stdout.trim().split(/\r?\n/u)[0])
    );
  });
}

const DEFAULT_ONE_SHOT_BINARY_RESOLVER: OneShotBinaryResolver = async (harness, env) => {
  if (harness === 'pi') {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const bundled = path.join(
      process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit'),
      'bin',
      `pi${suffix}`
    );
    if (
      await access(bundled)
        .then(() => true)
        .catch(() => false)
    )
      return bundled;
  }
  return resolveFromPath(harness, env);
};

interface PreparedOneShotInput {
  text: string;
  cleanup: () => Promise<void>;
}

async function prepareOneShotInput(
  text: string,
  attachments: AttachmentPayload[] | undefined,
  workDir: string
): Promise<PreparedOneShotInput> {
  const available = (attachments ?? []).filter((attachment) => attachment.data);
  if (available.length === 0) return { text, cleanup: async () => undefined };

  const inputDirectory = await mkdtemp(path.join(workDir, '.agentcli-input-'));
  const files: string[] = [];
  try {
    for (const [index, attachment] of available.entries()) {
      const safeName =
        path
          .basename(attachment.filename || `attachment-${index + 1}`)
          .replace(/[^\p{L}\p{N}._ -]/gu, '_') || `attachment-${index + 1}`;
      const filePath = path.join(inputDirectory, `${index + 1}-${safeName}`);
      await writeFile(filePath, Buffer.from(attachment.data ?? '', 'base64'), { mode: 0o600 });
      files.push(
        `- ${attachment.filename}（${attachment.mimeType || 'application/octet-stream'}）：${filePath}`
      );
    }
  } catch (error) {
    await rm(inputDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    text: `${text}\n\n用户附带了以下本地输入文件。请按路径读取并纳入本次任务，不要忽略：\n${files.join('\n')}`,
    cleanup: () => rm(inputDirectory, { recursive: true, force: true }),
  };
}

function codexFinalText(stdout: string): string {
  let finalText = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item =
        event.item && typeof event.item === 'object'
          ? (event.item as Record<string, unknown>)
          : undefined;
      const candidate =
        (item?.type === 'agent_message' && typeof item.text === 'string' ? item.text : undefined) ??
        (typeof event.output_text === 'string' ? event.output_text : undefined) ??
        (typeof event.text === 'string' ? event.text : undefined);
      if (candidate?.trim()) finalText = candidate.trim();
    } catch {
      // Codex may emit an occasional non-JSON diagnostic line; stderr remains the error source.
    }
  }
  return finalText || stdout.trim();
}

const DEFAULT_ENV_RESOLVER: DirectCliEnvResolver = async (params) => {
  // Imported lazily so the manager module stays cheap and unit-testable without the
  // credential/provider service graph.
  const { buildProviderAwareCliEnv } = await import('@main/services/runtime/providerAwareCliEnv');
  const result = await buildProviderAwareCliEnv({
    binaryPath: params.binaryPath,
    providerId: params.providerId,
    providerBackendId: params.providerBackendId ?? null,
    model: params.model ?? null,
    projectPath: params.projectPath,
  });
  return { env: result.env, providerArgs: result.providerArgs };
};

export class DirectCliSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, CliSessionHandle>();
  private readonly oneShotSessions = new Map<string, OneShotSessionHandle>();

  /** Keys reserved while one-shot binary/env resolution is still in flight. */
  private readonly startingOneShotSessions = new Set<string>();

  /** In-flight ensureSession promises dedupe concurrent callers for the same key. */
  private readonly ensuring = new Map<string, Promise<void>>();

  private shuttingDown = false;

  private shutdownPromise: Promise<void> | null = null;

  private readonly spawnFn: DirectCliSpawnFn;

  private readonly envResolver: DirectCliEnvResolver;

  private readonly binaryResolver: typeof ClaudeBinaryResolver;

  private readonly oneShotBinaryResolver: OneShotBinaryResolver;

  private readonly store: DirectCliSessionRepository;

  constructor(options: DirectCliSessionManagerOptions = {}) {
    super();
    this.spawnFn =
      options.spawnFn ?? ((binaryPath, args, opts) => spawnCli(binaryPath, args, opts));
    this.envResolver = options.envResolver ?? DEFAULT_ENV_RESOLVER;
    this.binaryResolver = options.binaryResolver ?? ClaudeBinaryResolver;
    this.oneShotBinaryResolver = options.oneShotBinaryResolver ?? DEFAULT_ONE_SHOT_BINARY_RESOLVER;
    this.store = options.store ?? new DirectCliSessionStore();
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey) || this.oneShotSessions.has(sessionKey);
  }

  getSessionId(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey)?.sessionId ?? this.store.get(sessionKey);
  }

  /**
   * Ensure a subprocess exists for `sessionKey`, spawning lazily. Resolves once the
   * process is running (NOT once claude is ready — the first `session-init` event
   * signals readiness). Safe to call concurrently; duplicate callers await the same spawn.
   */
  async ensureSession(params: DirectCliSpawnParams): Promise<void> {
    this.assertAcceptingWork();
    const sessionKey = params.sessionKey.trim();
    if (this.sessions.has(sessionKey)) return;
    const inFlight = this.ensuring.get(sessionKey);
    if (inFlight) return inFlight;

    const promise = this.spawnSession(sessionKey, params)
      .catch((err) => {
        // Surface the failure to SSE listeners, then re-throw so callers (send) know the
        // spawn failed and the session is unusable.
        const error = err instanceof Error ? err.message : String(err);
        this.emit('event', { kind: 'error', sessionKey, error } satisfies DirectCliEvent);
        throw err;
      })
      .finally(() => {
        // Clear the in-flight guard so a later retry can spawn again.
        this.ensuring.delete(sessionKey);
      });
    this.ensuring.set(sessionKey, promise);
    await promise;
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new Error('direct-cli: session manager is shutting down');
    }
  }

  private async spawnSession(sessionKey: string, params: DirectCliSpawnParams): Promise<void> {
    this.assertAcceptingWork();
    const workDir = params.workDir.trim();
    if (!workDir) throw new Error('direct-cli: workDir is required to spawn a agent session');

    const binaryPath = await this.binaryResolver.resolve();
    this.assertAcceptingWork();
    if (!binaryPath) {
      throw new Error('未找到本地 claude CLI，无法启动直连会话');
    }

    // Prefer a persisted session id (resume continuity across Hermit restarts); fall back
    // to the caller-provided resumeSessionId only if the store has nothing yet.
    const resumeSessionId = this.store.get(sessionKey) ?? params.resumeSessionId;

    const { env, providerArgs } = await this.envResolver({
      binaryPath,
      providerId: params.providerId,
      providerBackendId: params.providerBackendId,
      model: params.model ?? null,
      projectPath: workDir,
    });
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(params.teamSlug ? { HERMIT_TEAM_SLUG: params.teamSlug } : {}),
      ...(params.workbenchUrl ? { HERMIT_WORKBENCH_URL: params.workbenchUrl } : {}),
    };
    this.assertAcceptingWork();

    const args = buildClaudeStreamArgs({
      resumeSessionId,
      appendSystemPrompt: params.appendSystemPrompt,
      verbose: params.verbose,
      providerArgs,
    });

    this.assertAcceptingWork();
    const child = this.spawnFn(binaryPath, args, {
      cwd: workDir,
      env: runtimeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const handle: CliSessionHandle = {
      child,
      runId: randomUUID(),
      accumulatedText: '',
      stdoutBuffer: '',
      closed: false,
    };
    this.sessions.set(sessionKey, handle);
    this.attachListeners(sessionKey, handle);
  }

  private attachListeners(sessionKey: string, handle: CliSessionHandle): void {
    const { child } = handle;
    if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(sessionKey, handle, chunk));
    if (typeof child.stderr?.setEncoding === 'function') child.stderr.setEncoding('utf-8');
    child.stderr?.on('data', () => {
      // Stderr is informational (claude progress/debug). Not surfaced as message content.
    });
    child.on('error', (err) => {
      handle.closed = true;
      this.emit('event', {
        kind: 'error',
        sessionKey,
        error: err.message,
      } satisfies DirectCliEvent);
    });
    child.on('exit', (code) => {
      handle.closed = true;
      // Flush any trailing stdout line that never got a newline.
      if (handle.stdoutBuffer.trim()) {
        this.processLine(sessionKey, handle, handle.stdoutBuffer);
        handle.stdoutBuffer = '';
      }
      // Resolve any in-flight turn so the renderer's optimistic bubble can't hang
      // forever. If a `result` already arrived, `activeMessageId` was cleared and
      // nothing fires here. A clean exit (code 0) with no `result` (e.g. claude
      // bailed after a permission prompt) still needs a terminal `complete`.
      if (handle.activeMessageId) {
        if (code !== null && code !== 0) {
          this.emit('event', {
            kind: 'error',
            sessionKey,
            messageId: handle.activeMessageId,
            error: `claude 进程退出（code ${code}）`,
          } satisfies DirectCliEvent);
        } else if (code === 0) {
          this.emit('event', {
            kind: 'complete',
            sessionKey,
            messageId: handle.activeMessageId,
            text: handle.accumulatedText,
            sessionId: handle.sessionId,
          } satisfies DirectCliEvent);
        }
        handle.activeMessageId = undefined;
        handle.accumulatedText = '';
      }
      this.sessions.delete(sessionKey);
    });
  }

  private onStdout(sessionKey: string, handle: CliSessionHandle, chunk: string): void {
    handle.stdoutBuffer += chunk;
    let newlineIndex = handle.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = handle.stdoutBuffer.slice(0, newlineIndex);
      handle.stdoutBuffer = handle.stdoutBuffer.slice(newlineIndex + 1);
      this.processLine(sessionKey, handle, line);
      newlineIndex = handle.stdoutBuffer.indexOf('\n');
    }
  }

  private processLine(sessionKey: string, handle: CliSessionHandle, rawLine: string): void {
    const classified: ClaudeStreamLine | null = classifyClaudeStreamLine(rawLine);
    if (!classified) return;

    switch (classified.type) {
      case 'session-init': {
        handle.sessionId = classified.sessionId;
        this.store.set(sessionKey, classified.sessionId);
        this.emit('event', {
          kind: 'init',
          sessionKey,
          sessionId: classified.sessionId,
          model: classified.model,
        } satisfies DirectCliEvent);
        break;
      }
      case 'assistant': {
        const messageId = handle.activeMessageId ?? '';
        for (const block of classified.blocks) {
          if (block.kind === 'text' && block.text) {
            handle.accumulatedText += block.text;
            this.emit('event', {
              kind: 'delta',
              sessionKey,
              messageId,
              text: block.text,
            } satisfies DirectCliEvent);
          } else if (block.kind === 'thinking' && block.text) {
            this.emit('event', {
              kind: 'thinking',
              sessionKey,
              messageId,
              text: block.text,
            } satisfies DirectCliEvent);
          } else if (block.kind === 'tool-use') {
            this.emit('event', {
              kind: 'tool',
              sessionKey,
              messageId,
              toolName: block.toolName ?? 'Unknown',
              toolInput: block.toolInput,
            } satisfies DirectCliEvent);
          }
        }
        break;
      }
      case 'result': {
        const messageId = handle.activeMessageId ?? '';
        const text = classified.text || handle.accumulatedText;
        this.emit('event', {
          kind: 'complete',
          sessionKey,
          messageId,
          text,
          sessionId: classified.sessionId ?? handle.sessionId,
        } satisfies DirectCliEvent);
        handle.activeMessageId = undefined;
        handle.accumulatedText = '';
        break;
      }
      case 'control-request': {
        // A tool needs interactive approval (`--permission-prompt-tool stdio`). Surface it
        // so server.ts can render the approval sheet and write the control_response back.
        // Without this the CLI blocks on stdin forever and the turn never emits `result`.
        if (classified.requestId) {
          this.emit('event', {
            kind: 'permission-request',
            sessionKey,
            runId: handle.runId,
            requestId: classified.requestId,
            subtype: classified.subtype,
            toolName: classified.toolName,
            toolInput: classified.toolInput,
          } satisfies DirectCliEvent);
        }
        break;
      }
      case 'unknown':
      case 'parse-error':
      default:
        // parse-errors/unknown lines are ignored to avoid flooding the feed with raw stdout.
        break;
    }
  }

  /** Run Codex or bundled Pi as a bounded one-shot process and relay its final answer
   * through the same DirectCliEvent channel used by persistent Claude sessions. */
  async runOneShot(sessionKey: string, params: DirectCliOneShotParams): Promise<void> {
    this.assertAcceptingWork();
    const key = sessionKey.trim();
    if (!key) throw new Error('direct-cli: sessionKey is required');
    if (this.oneShotSessions.has(key) || this.startingOneShotSessions.has(key)) {
      throw new Error('该智能体正在处理上一条请求');
    }
    const workDir = params.workDir.trim();
    if (!workDir) throw new Error('direct-cli: workDir is required');
    this.startingOneShotSessions.add(key);
    let binaryPath: string;
    let runtimeEnv: NodeJS.ProcessEnv;
    let preparedInput: PreparedOneShotInput;
    try {
      const initialEnv = await this.envResolver({ binaryPath: null, projectPath: workDir });
      this.assertAcceptingWork();
      const resolvedBinary = await this.oneShotBinaryResolver(params.harness, initialEnv.env);
      if (!resolvedBinary) {
        throw new Error(params.harness === 'pi' ? '未找到内置 Pi' : '未找到本地 Codex CLI');
      }
      binaryPath = resolvedBinary;
      const { env } = await this.envResolver({ binaryPath, projectPath: workDir });
      this.assertAcceptingWork();
      runtimeEnv = {
        ...env,
        ...(params.teamSlug ? { HERMIT_TEAM_SLUG: params.teamSlug } : {}),
        ...(params.workbenchUrl ? { HERMIT_WORKBENCH_URL: params.workbenchUrl } : {}),
      };
      preparedInput = await prepareOneShotInput(params.text, params.attachments, workDir);
    } catch (error) {
      this.startingOneShotSessions.delete(key);
      throw error;
    }
    const args =
      params.harness === 'pi'
        ? ['--print', '--mode', 'text', '--no-session', '--no-approve']
        : [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--sandbox',
            'workspace-write',
            '-C',
            workDir,
            '-',
          ];
    let child: ChildProcess;
    try {
      child = this.spawnFn(binaryPath, args, {
        cwd: workDir,
        env: runtimeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.oneShotSessions.set(key, { child, messageId: params.messageId });
    } catch (error) {
      await preparedInput.cleanup();
      throw error;
    } finally {
      this.startingOneShotSessions.delete(key);
    }
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: string): string =>
      `${current}${chunk}`.slice(-ONE_SHOT_OUTPUT_LIMIT);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      this.oneShotSessions.delete(key);
      void preparedInput.cleanup();
      this.emit('event', {
        kind: 'error',
        sessionKey: key,
        messageId: params.messageId,
        error: error.message,
      } satisfies DirectCliEvent);
    });
    child.once('exit', (code, signal) => {
      void preparedInput.cleanup();
      const active = this.oneShotSessions.get(key);
      if (active?.messageId !== params.messageId) return;
      this.oneShotSessions.delete(key);
      if (code !== 0) {
        this.emit('event', {
          kind: 'error',
          sessionKey: key,
          messageId: params.messageId,
          error:
            stderr.trim() || `${params.harness} 进程异常退出（${signal || code || 'unknown'}）`,
        } satisfies DirectCliEvent);
        return;
      }
      const text = params.harness === 'codex' ? codexFinalText(stdout) : stdout.trim();
      if (!text) {
        this.emit('event', {
          kind: 'error',
          sessionKey: key,
          messageId: params.messageId,
          error: `${params.harness} 没有返回可用结果`,
        } satisfies DirectCliEvent);
        return;
      }
      this.emit('event', {
        kind: 'complete',
        sessionKey: key,
        messageId: params.messageId,
        text,
      } satisfies DirectCliEvent);
    });
    child.stdin?.end(preparedInput.text);
  }

  /**
   * Send a user turn to an existing (or about-to-be-spawned) session and tag the
   * resulting stream with `messageId` until the `result` event arrives.
   */
  async send(sessionKey: string, params: DirectCliSendParams): Promise<void> {
    const key = sessionKey.trim();
    await this.ensureSession({
      sessionKey: key,
      workDir: params.workDir,
      teamSlug: params.teamSlug,
      workbenchUrl: params.workbenchUrl,
    });
    this.assertAcceptingWork();
    const handle = this.sessions.get(key);
    if (!handle) {
      throw new Error(`direct-cli: session ${key} is not running`);
    }
    if (handle.closed || !handle.child.stdin || handle.child.stdin.destroyed) {
      throw new Error(`direct-cli: session ${key} stdin is closed`);
    }
    handle.activeMessageId = params.messageId;
    handle.accumulatedText = '';
    handle.child.stdin.write(formatClaudeStdinUserTurn(params.text, params.attachments));
  }

  /** Per-spawn run id for a live session (for dismissing stale approvals on respawn). */
  getRunId(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey.trim())?.runId;
  }

  /**
   * Answer a `permission-request` (control_request) by writing a `control_response` line to
   * the subprocess stdin. This unblocks the turn so the CLI can run the tool (allow) or
   * skip it (deny) and eventually emit the `result` that persists the reply.
   *
   * `updatedInput` carries the user's answers for `AskUserQuestion` (mirrors the multi-agent
   * reference impl: allow responses pass `{...toolInput, answers}` so the CLI delivers them
   * without re-prompting). Omit it for ordinary Allow.
   */
  respondPermission(
    sessionKey: string,
    requestId: string,
    allow: boolean,
    message?: string,
    updatedInput?: Record<string, unknown>
  ): void {
    const handle = this.sessions.get(sessionKey.trim());
    if (!handle) {
      throw new Error(`direct-cli: session ${sessionKey.trim()} is not running`);
    }
    if (handle.closed || !handle.child.stdin || handle.child.stdin.destroyed) {
      throw new Error(`direct-cli: session ${sessionKey.trim()} stdin is closed`);
    }
    // Wire format verified against the working multi-agent reference impl:
    // { type:'control_response', response:{ subtype:'success', request_id, response:{behavior, ...} } }
    const innerResponse: Record<string, unknown> = allow
      ? { behavior: 'allow', updatedInput: updatedInput ?? {} }
      : { behavior: 'deny', message: message ?? 'User denied' };
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: innerResponse,
      },
    };
    handle.child.stdin.write(JSON.stringify(response) + '\n');
  }

  kill(sessionKey: string): void {
    const key = sessionKey.trim();
    const handle = this.sessions.get(key);
    const oneShot = this.oneShotSessions.get(key);
    if (handle) handle.closed = true;
    for (const child of [handle?.child, oneShot?.child]) {
      if (!child) continue;
      try {
        // Kill the whole process tree: on Windows the child may be a cmd.exe
        // shell wrapper, and bare child.kill() would orphan the real process.
        killProcessTree(child, 'SIGTERM');
      } catch {
        // Best effort.
      }
    }
    this.sessions.delete(key);
    this.oneShotSessions.delete(key);
  }

  /** Reap every live subprocess and permanently reject new work. */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = (async () => {
        await Promise.allSettled(Array.from(this.ensuring.values()));
        const keys = new Set([...this.sessions.keys(), ...this.oneShotSessions.keys()]);
        for (const key of keys) this.kill(key);
      })();
    }
    return this.shutdownPromise;
  }
}

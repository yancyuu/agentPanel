import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { DirectCliEvent } from '../direct-cli';
import type { SystemDiagnosticRun } from '@shared/types/systemManager';

interface DiagnosticDirectCliGateway {
  on(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  off(eventName: 'event', listener: (event: DirectCliEvent) => void): unknown;
  kill(sessionKey: string): void;
}

interface SystemDiagnosticRunServiceDependencies {
  hermitHome: string;
  directCli: DiagnosticDirectCliGateway;
  ensureSystemManager(): Promise<unknown>;
  dispatchMessage(params: {
    teamName: string;
    sessionKey: string;
    workDir: string;
    from: string;
    to: string;
    text: string;
    messageId: string;
    conversationId: string;
    harness?: 'claudecode' | 'codex' | 'pi';
  }): Promise<void>;
  broadcast(run: SystemDiagnosticRun): void;
  timeoutMs?: number;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class SystemDiagnosticRunService {
  private readonly stateFile: string;
  private readonly timeoutMs: number;
  private activeMessageId: string | null = null;
  private activeSessionKey: string | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private readonly handleDirectCliEvent = (event: DirectCliEvent): void => {
    if (!this.activeMessageId || !this.activeSessionKey) return;
    if (event.kind === 'complete' && event.messageId === this.activeMessageId) {
      void this.finish('completed', event.text);
      return;
    }
    if (
      event.kind === 'error' &&
      (event.messageId === this.activeMessageId || event.sessionKey === this.activeSessionKey)
    ) {
      void this.finish('failed', undefined, event.error);
    }
  };

  constructor(private readonly dependencies: SystemDiagnosticRunServiceDependencies) {
    this.stateFile = path.join(dependencies.hermitHome, 'system-manager', 'diagnostic-run.json');
    this.timeoutMs = dependencies.timeoutMs ?? 20 * 60_000;
    dependencies.directCli.on('event', this.handleDirectCliEvent);
  }

  dispose(): void {
    this.dependencies.directCli.off('event', this.handleDirectCliEvent);
    if (this.timeout) clearTimeout(this.timeout);
  }

  async getCurrent(): Promise<SystemDiagnosticRun | null> {
    const run = await readJson<SystemDiagnosticRun | null>(this.stateFile, null);
    if (run?.status === 'running' && run.messageId !== this.activeMessageId) {
      const interrupted: SystemDiagnosticRun = {
        ...run,
        status: 'failed',
        error: '诊断服务已重启，请点击重新扫描。',
        completedAt: new Date().toISOString(),
      };
      await writeJson(this.stateFile, interrupted);
      return interrupted;
    }
    return run;
  }

  async start(input: {
    actionId: string;
    title: string;
    prompt: string;
    workDir: string;
  }): Promise<SystemDiagnosticRun> {
    const current = await this.getCurrent();
    if (current?.status === 'running') throw new Error('已有诊断正在执行，请等待完成');
    await this.dependencies.ensureSystemManager();

    const id = `diag_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const sessionKey = `system-manager:diagnostic:${id}`;
    const messageId = `diagnostic-${id}`;
    const run: SystemDiagnosticRun = {
      id,
      actionId: input.actionId,
      title: input.title,
      status: 'running',
      sessionKey,
      messageId,
      startedAt: new Date().toISOString(),
    };
    await writeJson(this.stateFile, run);
    this.activeMessageId = messageId;
    this.activeSessionKey = sessionKey;
    this.dependencies.broadcast(run);
    this.timeout = setTimeout(() => {
      this.dependencies.directCli.kill(sessionKey);
      void this.finish('failed', undefined, '诊断响应超时，请缩小扫描范围后重试。');
    }, this.timeoutMs);

    try {
      await this.dependencies.dispatchMessage({
        teamName: 'system-manager',
        sessionKey,
        workDir: input.workDir,
        from: '诊断',
        to: 'user',
        text: input.prompt,
        messageId,
        conversationId: `diagnostic:${id}`,
        // 诊断固定走 pi 运行时（one-shot 进程），与 system-manager 团队的默认 harness 无关
        harness: 'pi',
      });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish('failed', undefined, message);
      throw error;
    }
  }

  private async finish(
    status: 'completed' | 'failed',
    result?: string,
    error?: string
  ): Promise<void> {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    const current = await readJson<SystemDiagnosticRun | null>(this.stateFile, null);
    if (!current || current.messageId !== this.activeMessageId) return;
    const next: SystemDiagnosticRun = {
      ...current,
      status,
      result: result?.trim() || undefined,
      error: error?.trim() || undefined,
      completedAt: new Date().toISOString(),
    };
    await writeJson(this.stateFile, next);
    this.activeMessageId = null;
    this.activeSessionKey = null;
    this.dependencies.broadcast(next);
  }
}

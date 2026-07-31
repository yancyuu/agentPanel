import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SystemDiagnosticRunService } from '@main/services/system-manager/SystemDiagnosticRunService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DirectCliEvent } from '@main/services/direct-cli';

const temporaryDirectories: string[] = [];

class FakeDirectCli extends EventEmitter {
  killed: string[] = [];

  kill(sessionKey: string): void {
    this.killed.push(sessionKey);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('SystemDiagnosticRunService', () => {
  it('persists running state and stores the correlated diagnostic result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcli-diagnostic-'));
    temporaryDirectories.push(root);
    const directCli = new FakeDirectCli();
    const dispatchMessage = vi.fn(() => Promise.resolve());
    const broadcast = vi.fn();
    const service = new SystemDiagnosticRunService({
      hermitHome: root,
      directCli,
      ensureSystemManager: vi.fn(() => Promise.resolve()),
      dispatchMessage,
      broadcast,
      timeoutMs: 1000,
    });

    const run = await service.start({
      actionId: 'runtime-health',
      title: '运行环境检查',
      prompt: '只读检查运行环境',
      workDir: root,
    });
    expect((await service.getCurrent())?.status).toBe('running');
    expect(dispatchMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'system-manager',
        sessionKey: run.sessionKey,
        messageId: run.messageId,
      })
    );

    directCli.emit('event', {
      kind: 'complete',
      sessionKey: run.sessionKey,
      messageId: run.messageId,
      text: '# 诊断结果\n\n运行环境正常。',
    } satisfies DirectCliEvent);
    await vi.waitFor(async () => {
      expect((await service.getCurrent())?.status).toBe('completed');
    });
    expect((await service.getCurrent())?.result).toContain('运行环境正常');
    service.dispose();
  });
});

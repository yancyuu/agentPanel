import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import {
  buildClaudeStreamArgs,
  DirectCliSessionManager,
  formatClaudeStdinUserTurn,
} from './DirectCliSessionManager';

import type { SpawnOptions } from 'child_process';

/** Minimal fake ChildProcess: stdout/stderr/stdin as EventEmitters + kill. */
interface FakeChild {
  pid: number;
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  stdin: { write: (data: string) => boolean; end: (data?: string) => void; destroyed: boolean };
  kill: (signal?: string) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  emitExit: (code: number | null) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFakeChild(): FakeChild {
  const bus = new EventEmitter();
  const stdout = new EventEmitter() as FakeChild['stdout'];
  const stderr = new EventEmitter() as FakeChild['stderr'];
  stdout.setEncoding = () => undefined;
  stderr.setEncoding = () => undefined;
  const child: FakeChild = {
    // A non-existent pid lets killProcessTree run its best-effort process.kill
    // path (ESRCH, ignored) instead of short-circuiting on !pid.
    pid: 999_999,
    stdout,
    stderr,
    stdin: { write: () => true, end: () => undefined, destroyed: false },
    kill: () => undefined,
    on: (event, cb) => bus.on(event, cb),
    once: (event, cb) => bus.once(event, cb),
    emitExit: (code) => bus.emit('exit', code, null),
  };
  return child;
}

function createManager(providerArgs: string[] = []): {
  manager: DirectCliSessionManager;
  child: FakeChild;
} {
  const child = createFakeChild();
  const manager = new DirectCliSessionManager({
    spawnFn: () => child as unknown as import('child_process').ChildProcess,
    envResolver: async () => ({ env: { PATH: '/fake' }, providerArgs }),
    binaryResolver: { resolve: async () => '/fake/claude' } as never,
    store: new Map<string, string>() as never,
  });
  return { manager, child };
}

describe('buildClaudeStreamArgs', () => {
  it('emits the base stream-json flags with --verbose by default', () => {
    expect(buildClaudeStreamArgs()).toEqual([
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      '--verbose',
    ]);
  });

  it('adds --resume / --append-system-prompt / provider args when provided', () => {
    expect(
      buildClaudeStreamArgs({
        resumeSessionId: 'sid-1',
        appendSystemPrompt: 'You are admin.',
        verbose: false,
        providerArgs: ['--model', 'opus'],
      })
    ).toEqual([
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      // no --verbose because verbose:false
      '--resume',
      'sid-1',
      '--append-system-prompt',
      'You are admin.',
      '--model',
      'opus',
    ]);
  });

  it('omits --resume / --append-system-prompt when their values are blank', () => {
    const args = buildClaudeStreamArgs({ resumeSessionId: '   ', appendSystemPrompt: '' });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('formatClaudeStdinUserTurn', () => {
  it('produces a single NDJSON user line terminated by a newline', () => {
    const out = formatClaudeStdinUserTurn('fix the bug');
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    });
  });

  it('includes supported attachments as stream-json content blocks', () => {
    const out = formatClaudeStdinUserTurn('review these', [
      {
        id: 'img-1',
        filename: 'screen.png',
        mimeType: 'image/png',
        size: 10,
        data: 'image-base64',
      },
      {
        id: 'pdf-1',
        filename: 'spec.pdf',
        mimeType: 'application/pdf',
        size: 20,
        data: 'pdf-base64',
      },
      {
        id: 'txt-1',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        data: Buffer.from('hello').toString('base64'),
      },
    ]);

    expect(JSON.parse(out.trim())).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'review these' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'image-base64' },
          },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'pdf-base64' },
          },
          { type: 'text', text: '\n\n[Attachment: notes.txt]\nhello' },
        ],
      },
    });
  });
});

describe('DirectCliSessionManager', () => {
  it('spawns on first ensureSession with cwd=workDir and base args', async () => {
    let spawnArgs: string[] = [];
    let spawnOpts: SpawnOptions = {};
    const child = createFakeChild();
    const manager = new DirectCliSessionManager({
      spawnFn: (_bin, args, opts) => {
        spawnArgs = args;
        spawnOpts = opts;
        return child as unknown as import('child_process').ChildProcess;
      },
      envResolver: async () => ({ env: { X: '1' }, providerArgs: [] }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });

    await manager.ensureSession({ sessionKey: 't:lead', workDir: '/proj' });

    expect(manager.has('t:lead')).toBe(true);
    expect(spawnOpts.cwd).toBe('/proj');
    expect(spawnOpts.env).toEqual({ X: '1' });
    expect(spawnArgs).toContain('--output-format');
    expect(spawnArgs).toContain('stream-json');
    expect(spawnArgs).toContain('--verbose');
  });

  it('injects the canonical team and Workbench endpoint into the spawned runtime', async () => {
    let spawnOpts: SpawnOptions = {};
    const child = createFakeChild();
    const manager = new DirectCliSessionManager({
      spawnFn: (_bin, _args, opts) => {
        spawnOpts = opts;
        return child as unknown as import('child_process').ChildProcess;
      },
      envResolver: async () => ({
        env: { PATH: '/managed/bin', PROVIDER_KEY: 'secret' },
        providerArgs: [],
      }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });

    await manager.send('team-a:lead', {
      text: '开始任务',
      messageId: 'message-1',
      workDir: '/proj',
      teamSlug: 'team-a',
      workbenchUrl: 'http://127.0.0.1:5681',
    });

    expect(spawnOpts.env).toEqual({
      PATH: '/managed/bin',
      PROVIDER_KEY: 'secret',
      HERMIT_TEAM_SLUG: 'team-a',
      HERMIT_WORKBENCH_URL: 'http://127.0.0.1:5681',
    });
  });

  it('runs bundled Pi as a one-shot session and emits a normal complete event', async () => {
    const child = createFakeChild();
    let spawnArgs: string[] = [];
    let stdin = '';
    child.stdin.end = (data?: string) => {
      stdin = data ?? '';
    };
    const manager = new DirectCliSessionManager({
      spawnFn: (_binary, args) => {
        spawnArgs = args;
        return child as unknown as import('child_process').ChildProcess;
      },
      envResolver: async () => ({ env: { PATH: '/managed/bin' }, providerArgs: [] }),
      oneShotBinaryResolver: async () => '/fake/pi',
      store: new Map<string, string>() as never,
    });
    const events: { kind: string; text?: string }[] = [];
    manager.on('event', (event) => events.push(event));

    await manager.runOneShot('team-pi:task:1', {
      harness: 'pi',
      text: '完成任务',
      messageId: 'pi-message',
      workDir: '/proj',
      teamSlug: 'team-pi',
      workbenchUrl: 'http://127.0.0.1:5681',
    });
    child.stdout.emit('data', 'Pi 已完成交付');
    child.emitExit(0);

    expect(spawnArgs).toEqual(['--print', '--mode', 'text', '--no-session', '--no-approve']);
    expect(stdin).toBe('完成任务');
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'complete', text: 'Pi 已完成交付' })
    );
  });

  it('runs Codex in JSON mode and extracts the final agent message', async () => {
    const child = createFakeChild();
    let stdin = '';
    child.stdin.end = (data?: string) => {
      stdin = data ?? '';
    };
    const manager = new DirectCliSessionManager({
      spawnFn: () => child as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      oneShotBinaryResolver: async () => '/fake/codex',
      store: new Map<string, string>() as never,
    });
    const events: { kind: string; text?: string }[] = [];
    manager.on('event', (event) => events.push(event));

    await manager.runOneShot('team-codex:task:1', {
      harness: 'codex',
      text: '分析任务',
      messageId: 'codex-message',
      workDir: '/proj',
    });
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex 最终结果' } })}\n`
    );
    child.emitExit(0);

    expect(stdin).toBe('分析任务');
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'complete', text: 'Codex 最终结果' })
    );
  });

  it('materializes attachments inside the workspace for Codex/Pi one-shot prompts', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'direct-cli-attachments-'));
    const child = createFakeChild();
    let stdin = '';
    child.stdin.end = (data?: string) => {
      stdin = data ?? '';
    };
    const manager = new DirectCliSessionManager({
      spawnFn: () => child as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      oneShotBinaryResolver: async () => '/fake/codex',
      store: new Map<string, string>() as never,
    });
    try {
      await manager.runOneShot('team-codex:attachments', {
        harness: 'codex',
        text: '阅读附件',
        messageId: 'attachment-message',
        workDir,
        attachments: [
          {
            id: 'attachment-1',
            filename: '资料.txt',
            mimeType: 'text/plain',
            size: Buffer.byteLength('附件正文'),
            data: Buffer.from('附件正文', 'utf8').toString('base64'),
          },
        ],
      });
      expect(stdin).toContain('用户附带了以下本地输入文件');
      const attachmentPath = /：([^\n]+)$/mu.exec(stdin)?.[1];
      expect(attachmentPath).toBeTruthy();
      expect(await readFile(attachmentPath ?? '', 'utf8')).toBe('附件正文');

      child.stdout.emit('data', `${JSON.stringify({ text: '完成' })}\n`);
      child.emitExit(0);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          await access(attachmentPath ?? '')
            .then(() => false)
            .catch(() => true)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(access(attachmentPath ?? '')).rejects.toBeDefined();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('resolves Codex from the provider-aware PATH', async () => {
    const child = createFakeChild();
    child.stdin.end = () => undefined;
    let resolverEnv: NodeJS.ProcessEnv | undefined;
    const manager = new DirectCliSessionManager({
      spawnFn: () => child as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: { PATH: '/provider/bin' }, providerArgs: [] }),
      oneShotBinaryResolver: async (_harness, env) => {
        resolverEnv = env;
        return '/provider/bin/codex';
      },
      store: new Map<string, string>() as never,
    });

    await manager.runOneShot('team-codex:path', {
      harness: 'codex',
      text: '分析任务',
      messageId: 'codex-path-message',
      workDir: '/proj',
    });

    expect(resolverEnv?.PATH).toBe('/provider/bin');
  });

  it('reserves one-shot session keys before asynchronous binary resolution', async () => {
    const environment = deferred<{ env: NodeJS.ProcessEnv; providerArgs: string[] }>();
    const child = createFakeChild();
    child.stdin.end = () => undefined;
    let spawnCount = 0;
    const manager = new DirectCliSessionManager({
      spawnFn: () => {
        spawnCount += 1;
        return child as unknown as import('child_process').ChildProcess;
      },
      envResolver: () => environment.promise,
      oneShotBinaryResolver: async () => '/fake/codex',
      store: new Map<string, string>() as never,
    });
    const first = manager.runOneShot('team-codex:dedupe', {
      harness: 'codex',
      text: '第一次',
      messageId: 'one',
      workDir: '/proj',
    });
    await Promise.resolve();

    await expect(
      manager.runOneShot('team-codex:dedupe', {
        harness: 'codex',
        text: '第二次',
        messageId: 'two',
        workDir: '/proj',
      })
    ).rejects.toThrow('上一条请求');

    environment.resolve({ env: { PATH: '/provider/bin' }, providerArgs: [] });
    await first;
    expect(spawnCount).toBe(1);
  });

  it('does not spawn twice for the same session key (dedupes concurrent ensureSession)', async () => {
    let spawnCount = 0;
    const child = createFakeChild();
    const manager = new DirectCliSessionManager({
      spawnFn: () => {
        spawnCount += 1;
        return child as unknown as import('child_process').ChildProcess;
      },
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });

    await Promise.all([
      manager.ensureSession({ sessionKey: 't:lead', workDir: '/proj' }),
      manager.ensureSession({ sessionKey: 't:lead', workDir: '/proj' }),
    ]);
    await manager.ensureSession({ sessionKey: 't:lead', workDir: '/proj' });

    expect(spawnCount).toBe(1);
  });

  it('emits init → delta → tool → complete for a real stream and captures session id', async () => {
    const { manager, child } = createManager(['--model', 'sonnet']);

    const events: string[] = [];
    manager.on('event', (e: { kind: string }) => events.push(e.kind));

    await manager.send('t:lead', { text: 'fixbug', messageId: 'm1', workDir: '/proj' });

    // system init carries the claude session id (captured for --resume next time)
    child.stdout.emit(
      'data',
      JSON.stringify({ type: 'system', session_id: 'claude-sid-9', model: 'claude-sonnet-4-6' }) +
        '\n'
    );
    // assistant text delta
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'working on it' }] },
      }) + '\n'
    );
    // assistant tool_use
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }],
        },
      }) + '\n'
    );
    // result
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: 'claude-sid-9',
      }) + '\n'
    );

    expect(events).toEqual(['init', 'delta', 'tool', 'complete']);
    // getSessionId reads the handle's captured session id
    expect(manager.getSessionId('t:lead')).toBe('claude-sid-9');
  });

  it('writes the user turn to stdin as NDJSON on send', async () => {
    const child = createFakeChild();
    let written = '';
    child.stdin.write = (data: string) => {
      written = data;
      return true;
    };
    const manager = new DirectCliSessionManager({
      spawnFn: () => child as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });
    await manager.send('t:lead', { text: 'hello', messageId: 'm1', workDir: '/proj' });
    expect(JSON.parse(written.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('falls back to accumulated text when result has no result field', async () => {
    const { manager, child } = createManager();
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial reply' }] },
      }) + '\n'
    );
    let completeText = '';
    manager.on('event', (e: { kind: string; text?: string }) => {
      if (e.kind === 'complete') completeText = e.text ?? '';
    });
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
    expect(completeText).toBe('partial reply');
  });

  it('emits permission-request when a can_use_tool control_request arrives', async () => {
    const { manager, child } = createManager();
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    const events: {
      kind: string;
      requestId?: string;
      subtype?: string;
      toolName?: string;
      runId?: string;
    }[] = [];
    manager.on('event', (e) => {
      if (e.kind === 'permission-request') events.push(e as (typeof events)[number]);
    });
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_42',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      }) + '\n'
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'permission-request',
      requestId: 'req_42',
      subtype: 'can_use_tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(typeof events[0].runId).toBe('string');
  });

  it('respondPermission writes a control_response line to stdin (allow/deny)', async () => {
    const { manager, child } = createManager();
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    const written: string[] = [];
    child.stdin.write = (data: string) => {
      written.push(data);
      return true;
    };
    manager.respondPermission('t:lead', 'req_42', true);
    manager.respondPermission('t:lead', 'req_43', false, 'User denied');
    expect(written.map((line) => JSON.parse(line.trim()))).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_42',
          response: { behavior: 'allow', updatedInput: {} },
        },
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_43',
          response: { behavior: 'deny', message: 'User denied' },
        },
      },
    ]);
  });

  it('respondPermission passes updatedInput through for AskUserQuestion answers (allow)', async () => {
    const { manager, child } = createManager();
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    const written: string[] = [];
    child.stdin.write = (data: string) => {
      written.push(data);
      return true;
    };
    const answers = { 'Pick one': 'A' };
    manager.respondPermission('t:lead', 'req_99', true, undefined, {
      ...{ prompt: 'Pick one' },
      answers,
    });
    const parsed = JSON.parse(written[0].trim());
    expect(parsed).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_99',
        response: { behavior: 'allow', updatedInput: { prompt: 'Pick one', answers } },
      },
    });
  });

  it('respondPermission throws when the session is not running', async () => {
    const { manager } = createManager();
    expect(() => manager.respondPermission('missing:lead', 'req_1', true)).toThrow(
      /is not running/
    );
  });

  it('ignores parse-error and unknown lines without emitting', async () => {
    const { manager, child } = createManager();
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    const events: string[] = [];
    manager.on('event', (e: { kind: string }) => events.push(e.kind));
    child.stdout.emit('data', 'this is not json\n');
    child.stdout.emit('data', JSON.stringify({ type: 'stream_event' }) + '\n');
    expect(events).toEqual([]);
  });

  it('emits error and drops the handle when the process exits non-zero mid-turn', async () => {
    const { manager, child } = createManager();
    const events: { kind: string; error?: string }[] = [];
    manager.on('event', (e: { kind: string; error?: string }) => events.push(e));
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    child.emitExit(1);
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect(manager.has('t:lead')).toBe(false);
  });

  it('synthesizes a complete event on clean exit mid-turn (no stuck bubble)', async () => {
    const { manager, child } = createManager();
    const events: { kind: string; text?: string }[] = [];
    manager.on('event', (e: { kind: string; text?: string }) => events.push(e));
    await manager.send('t:lead', { text: 'x', messageId: 'm1', workDir: '/proj' });
    // No `result` line ever arrives — claude exits cleanly (e.g. bailed after a
    // permission prompt). The turn must still terminate so the optimistic bubble
    // doesn't hang forever.
    child.emitExit(0);
    expect(events.some((e) => e.kind === 'complete')).toBe(true);
    expect(manager.has('t:lead')).toBe(false);
  });

  it('shutdown kills all live sessions', async () => {
    const child = createFakeChild();
    const manager = new DirectCliSessionManager({
      spawnFn: () => child as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });
    await manager.ensureSession({ sessionKey: 'a:lead', workDir: '/p' });
    await manager.ensureSession({ sessionKey: 'b:lead', workDir: '/p' });
    await manager.shutdown();
    // shutdown reaps every session (via killProcessTree — best-effort,
    // OS-dependent) and removes them from the live map.
    expect(manager.has('a:lead')).toBe(false);
    expect(manager.has('b:lead')).toBe(false);
  });

  it('makes shutdown terminal and prevents a delayed ensure from spawning afterward', async () => {
    const environment = deferred<{ env: NodeJS.ProcessEnv; providerArgs: string[] }>();
    let spawnCount = 0;
    const manager = new DirectCliSessionManager({
      spawnFn: () => {
        spawnCount += 1;
        return createFakeChild() as unknown as import('child_process').ChildProcess;
      },
      envResolver: () => environment.promise,
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });

    const ensuring = manager.ensureSession({ sessionKey: 'delayed:lead', workDir: '/proj' });
    await Promise.resolve();
    const shutdown = manager.shutdown();
    environment.resolve({ env: {}, providerArgs: [] });

    await expect(ensuring).rejects.toThrow('shutting down');
    await shutdown;
    expect(spawnCount).toBe(0);
    await expect(
      manager.ensureSession({ sessionKey: 'after:lead', workDir: '/proj' })
    ).rejects.toThrow('shutting down');
  });

  it('throws a clear error when workDir is missing', async () => {
    const manager = new DirectCliSessionManager({
      spawnFn: () => createFakeChild() as unknown as import('child_process').ChildProcess,
      envResolver: async () => ({ env: {}, providerArgs: [] }),
      binaryResolver: { resolve: async () => '/fake/claude' } as never,
      store: new Map<string, string>() as never,
    });
    await expect(manager.ensureSession({ sessionKey: 't:lead', workDir: '' })).rejects.toThrow(
      /workDir/
    );
  });
});

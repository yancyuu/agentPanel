import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { GroupMessage } from '../../../src/main/services/team-management/TeamWorkspaceService';
import { createServerRuntimeState } from '../../../src/main/serverContext';
import { registerServerEventHandlers } from '../../../src/main/serverEventHandlers';

const PERSISTED_MESSAGE: GroupMessage = {
  id: 'persisted-message',
  ts: '2026-01-02T03:04:05.000Z',
  from: 'team-a',
  to: 'user',
  role: 'agent',
  content: 'persisted',
  meta: null,
};

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness() {
  const directCliManager = new EventEmitter() as EventEmitter & {
    respondPermission: ReturnType<typeof vi.fn>;
  };
  directCliManager.respondPermission = vi.fn();
  const bridge = new EventEmitter();
  const state = createServerRuntimeState();
  const appendMessage = vi.fn(async (): Promise<GroupMessage> => PERSISTED_MESSAGE);
  const broadcastSse = vi.fn();
  const resolveTeamFromBridgeMessage = vi.fn(async () => 'team-a');
  const logger = { warn: vi.fn() };

  const register = () =>
    registerServerEventHandlers({
      state,
      directCliManager,
      bridge,
      appendMessage,
      broadcastSse,
      resolveTeamFromBridgeMessage,
      logger,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });

  return {
    appendMessage,
    bridge,
    broadcastSse,
    directCliManager,
    logger,
    register,
    resolveTeamFromBridgeMessage,
    state,
  };
}

describe('server event handlers', () => {
  it('registers one listener per event and removes the exact listener references', () => {
    const harness = createHarness();
    const dispose = harness.register();

    expect(harness.directCliManager.listenerCount('event')).toBe(1);
    expect(harness.bridge.listenerCount('reply')).toBe(1);
    expect(harness.bridge.listenerCount('reply_stream')).toBe(1);
    expect(harness.bridge.listenerCount('message')).toBe(1);

    dispose();
    expect(harness.directCliManager.listenerCount('event')).toBe(0);
    expect(harness.bridge.listenerCount('reply')).toBe(0);
    expect(harness.bridge.listenerCount('reply_stream')).toBe(0);
    expect(harness.bridge.listenerCount('message')).toBe(0);

    const disposeAgain = harness.register();
    expect(harness.bridge.listenerCount('reply')).toBe(1);
    disposeAgain();
  });

  it('persists direct-cli completion with the canonical messageId before broadcasting', async () => {
    const harness = createHarness();
    const pendingAppend = deferred<GroupMessage>();
    harness.appendMessage.mockReturnValueOnce(pendingAppend.promise);
    harness.state.directCliRoutes.set('session-1', {
      teamName: 'team-a',
      from: 'team-a',
      to: 'user',
    });
    harness.register();

    harness.directCliManager.emit('event', {
      kind: 'complete',
      sessionKey: 'session-1',
      messageId: 'message-42',
      text: '完成结果',
    });
    await Promise.resolve();

    expect(harness.appendMessage).toHaveBeenCalledWith('team-a', {
      id: 'message-42',
      from: 'team-a',
      to: 'user',
      role: 'agent',
      content: '完成结果',
      meta: { sessionKey: 'session-1', source: 'direct-cli' },
    });
    expect(harness.broadcastSse).not.toHaveBeenCalled();

    pendingAppend.resolve(PERSISTED_MESSAGE);
    await flushAsyncWork();
    expect(harness.broadcastSse).toHaveBeenCalledWith('team-change', {
      type: 'inbox',
      teamName: 'team-a',
    });
  });

  it('auto-allows configured permission requests and queues denied requests', async () => {
    const harness = createHarness();
    harness.state.directCliRoutes.set('session-1', {
      teamName: 'team-a',
      from: 'team-a',
      to: 'user',
    });
    harness.state.toolApprovalSettingsByName.set('team-a', {
      autoAllowAll: true,
      autoAllowFileEdits: false,
      autoAllowSafeBash: false,
      timeoutAction: 'wait',
      timeoutSeconds: 0,
    });
    harness.register();

    harness.directCliManager.emit('event', {
      kind: 'permission-request',
      subtype: 'can_use_tool',
      sessionKey: 'session-1',
      requestId: 'allow-1',
      runId: 'run-1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    });
    await flushAsyncWork();

    expect(harness.directCliManager.respondPermission).toHaveBeenCalledWith(
      'session-1',
      'allow-1',
      true
    );
    expect(harness.state.permissionSessionByRequestId.has('allow-1')).toBe(false);

    harness.state.toolApprovalSettingsByName.set('team-a', {
      autoAllowAll: false,
      autoAllowFileEdits: false,
      autoAllowSafeBash: false,
      timeoutAction: 'wait',
      timeoutSeconds: 0,
    });
    harness.directCliManager.emit('event', {
      kind: 'permission-request',
      subtype: 'can_use_tool',
      sessionKey: 'session-1',
      requestId: 'deny-1',
      runId: 'run-2',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    });
    await flushAsyncWork();

    expect(harness.state.permissionSessionByRequestId.get('deny-1')).toEqual({
      sessionKey: 'session-1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    });
    expect(harness.broadcastSse).toHaveBeenCalledWith('tool-approval-event', {
      requestId: 'deny-1',
      runId: 'run-2',
      teamName: 'team-a',
      source: 'lead',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      receivedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('persists bridge replies before broadcasting an inbox refresh', async () => {
    const harness = createHarness();
    const pendingAppend = deferred<GroupMessage>();
    harness.appendMessage.mockReturnValueOnce(pendingAppend.promise);
    harness.register();

    harness.bridge.emit('reply', {
      session_key: 'bridge-session',
      content: '外部回复',
    });
    await Promise.resolve();

    expect(harness.appendMessage).toHaveBeenCalledWith('team-a', {
      from: 'team-a',
      to: 'user',
      role: 'agent',
      content: '外部回复',
      meta: { sessionKey: 'bridge-session' },
    });
    expect(harness.broadcastSse).not.toHaveBeenCalled();

    pendingAppend.resolve(PERSISTED_MESSAGE);
    await flushAsyncWork();
    expect(harness.broadcastSse).toHaveBeenCalledWith('team-change', {
      type: 'inbox',
      teamName: 'team-a',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { CcConnectBridge } from './CcConnectBridge';

import type { CcBridgeReplyMessage, CcBridgeUsageMessage } from '@shared/types/ccConnect';

/**
 * The dispatch in handleIncomingMessage is private and normally driven by the
 * live WebSocket. We exercise it directly (without start()) to lock the new
 * usage-observer fan-out: a `usage` frame must surface as a typed `usage` event,
 * and existing reply/default routing must not regress.
 */
function dispatch(bridge: CcConnectBridge, msg: unknown): void {
  (bridge as unknown as { handleIncomingMessage: (m: unknown) => void }).handleIncomingMessage(msg);
}

const usageMsg: CcBridgeUsageMessage = {
  type: 'usage',
  session_key: 'feishu:oc_chat1:ou_user1',
  platform: 'feishu',
  agent_type: 'claudecode',
  input_tokens: 932,
  output_tokens: 587,
  cache_read_input_tokens: 126016,
  cache_creation_input_tokens: 3,
  ts: 1_718_900_000,
};

const replyMsg: CcBridgeReplyMessage = {
  type: 'reply',
  session_key: 'feishu:oc_chat1:ou_user1',
  content: 'hi',
};

describe('CcConnectBridge usage-observer dispatch', () => {
  it('emits a usage event for a usage frame', () => {
    const bridge = new CcConnectBridge({ bridgeToken: 'x' });
    let received: CcBridgeUsageMessage | undefined;
    bridge.on('usage', (msg) => {
      received = msg;
    });

    dispatch(bridge, usageMsg);

    expect(received).toEqual(usageMsg);
  });

  it('does not emit usage for a reply frame (no fan-out leakage)', () => {
    const bridge = new CcConnectBridge({ bridgeToken: 'x' });
    const usageCalls: CcBridgeUsageMessage[] = [];
    let replyReceived: CcBridgeReplyMessage | undefined;
    bridge.on('usage', (msg) => usageCalls.push(msg));
    bridge.on('reply', (msg) => {
      replyReceived = msg;
    });

    dispatch(bridge, replyMsg);

    expect(usageCalls).toHaveLength(0);
    expect(replyReceived).toEqual(replyMsg);
  });
});

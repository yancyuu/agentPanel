/**
 * MessageBridge — Routes hermit-bridge WebSocket messages to Hermit
 * team members and broadcasts them as SSE events.
 *
 * Receives agent output from HermitBridgeConnection, maps session_key back to
 * team/member using ProjectMappingStore, and emits SSE events.
 */

import { createLogger } from '@shared/utils/logger';

import type { HermitBridgeConnection } from './HermitBridgeConnection';
import type { ProjectMappingStore } from './ProjectMappingStore';
import type {
  HermitBridgeIncomingMessage,
  HermitBridgeReplyMessage,
  HermitBridgeReplyStreamMessage,
} from '@shared/types/hermitBridge';

const logger = createLogger('MessageBridge');

export interface TeamMessageEvent {
  teamName: string;
  memberName: string;
  type: 'reply' | 'reply_stream' | 'typing_start' | 'typing_stop' | 'card' | 'buttons';
  content?: string;
  delta?: string;
  fullText?: string;
  done?: boolean;
  sessionKey: string;
  timestamp: string;
  raw?: unknown;
}

export type BroadcastFn = (channel: string, data: unknown) => void;

export class MessageBridge {
  private broadcastFn: BroadcastFn | null = null;

  constructor(
    private readonly bridge: HermitBridgeConnection,
    private readonly mappingStore: ProjectMappingStore
  ) {
    this.bridge.on('reply', (msg: HermitBridgeReplyMessage) => this.handleReply(msg));
    this.bridge.on('reply_stream', (msg: HermitBridgeReplyStreamMessage) =>
      this.handleReplyStream(msg)
    );
    this.bridge.on('message', (msg: HermitBridgeIncomingMessage) => this.handleGenericMessage(msg));
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }

  private resolveMapping(sessionKey: string): { teamName: string; memberName: string } | null {
    // Session key format: bridge:hermit-{teamName}:{memberName}
    // or look up by stored session key in mappings
    const mapping = this.mappingStore.getAllMappings().find((m) => m.sessionKey === sessionKey);
    if (mapping) {
      return { teamName: mapping.teamName, memberName: mapping.memberName };
    }

    // Try parsing from session key pattern
    const match = /^bridge:hermit-([^:]+):(.+)$/.exec(sessionKey);
    if (match) {
      return { teamName: match[1], memberName: match[2] };
    }

    // Try matching cc-connect project name from any session key
    for (const m of this.mappingStore.getAllMappings()) {
      if (sessionKey.includes(m.ccProjectName)) {
        return { teamName: m.teamName, memberName: m.memberName };
      }
    }

    return null;
  }

  private handleReply(msg: HermitBridgeReplyMessage): void {
    const target = this.resolveMapping(msg.session_key);
    if (!target) {
      logger.warn(`No mapping found for session_key: ${msg.session_key}`);
      return;
    }

    const event: TeamMessageEvent = {
      teamName: target.teamName,
      memberName: target.memberName,
      type: 'reply',
      content: msg.content,
      sessionKey: msg.session_key,
      timestamp: new Date().toISOString(),
    };

    this.broadcast(event);
  }

  private handleReplyStream(msg: HermitBridgeReplyStreamMessage): void {
    const target = this.resolveMapping(msg.session_key);
    if (!target) return;

    const event: TeamMessageEvent = {
      teamName: target.teamName,
      memberName: target.memberName,
      type: 'reply_stream',
      delta: msg.delta,
      fullText: msg.full_text,
      done: msg.done,
      sessionKey: msg.session_key,
      timestamp: new Date().toISOString(),
    };

    this.broadcast(event);
  }

  private handleGenericMessage(msg: HermitBridgeIncomingMessage): void {
    if (msg.type === 'typing_start' || msg.type === 'typing_stop') {
      const target = this.resolveMapping(msg.session_key);
      if (!target) return;

      const event: TeamMessageEvent = {
        teamName: target.teamName,
        memberName: target.memberName,
        type: msg.type,
        sessionKey: msg.session_key,
        timestamp: new Date().toISOString(),
      };
      this.broadcast(event);
      return;
    }

    // For card, buttons, etc. — forward as raw
    if ('session_key' in msg) {
      const target = this.resolveMapping((msg as { session_key: string }).session_key);
      if (!target) return;

      const event: TeamMessageEvent = {
        teamName: target.teamName,
        memberName: target.memberName,
        type: msg.type as TeamMessageEvent['type'],
        sessionKey: (msg as { session_key: string }).session_key,
        timestamp: new Date().toISOString(),
        raw: msg,
      };
      this.broadcast(event);
    }
  }

  private broadcast(event: TeamMessageEvent): void {
    if (!this.broadcastFn) return;

    // Broadcast as team-change for general team state updates
    this.broadcastFn('team-change', {
      type: 'message',
      teamName: event.teamName,
      memberName: event.memberName,
      detail: event,
    });

    // Also broadcast as agent-message for message-specific listeners
    this.broadcastFn('agent-message', event);
  }
}

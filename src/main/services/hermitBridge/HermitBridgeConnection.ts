/**
 * HermitBridgeConnection — WebSocket client for hermit-bridge Bridge Server.
 *
 * Registers as a "hermit" platform adapter and maintains a persistent
 * WebSocket connection to receive real-time agent output (replies, streaming,
 * cards, typing indicators) and send user messages.
 *
 * Uses Node.js built-in WebSocket (available since Node 22+).
 * Default target: ws://127.0.0.1:9810/bridge/ws
 */

import { HERMIT_BRIDGE_DEFAULTS } from '@shared/types/hermitBridge';
import { createLogger } from '@shared/utils/logger';
import { EventEmitter } from 'events';

import type {
  HermitBridgeConnectionConfig,
  HermitBridgeIncomingMessage,
  HermitBridgeOutgoingMessage,
  HermitBridgeReplyMessage,
  HermitBridgeReplyStreamMessage,
  HermitBridgeUsageMessage,
  HermitBridgeUserMessage,
} from '@shared/types/hermitBridge';

const logger = createLogger('HermitBridgeConnection');

const RECONNECT_DELAY_MS = 3_000;
const PING_INTERVAL_MS = 30_000;
const BRIDGE_CAPABILITIES = ['text', 'buttons', 'card', 'typing', 'update_message', 'preview'];

export interface HermitBridgeConnectionEvents {
  connected: [];
  disconnected: [error?: Error];
  reply: [message: HermitBridgeReplyMessage];
  reply_stream: [message: HermitBridgeReplyStreamMessage];
  usage: [message: HermitBridgeUsageMessage];
  message: [message: HermitBridgeIncomingMessage];
}

export class HermitBridgeConnection extends EventEmitter {
  private bridgeUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _disposed = false;

  constructor(config?: Partial<HermitBridgeConnectionConfig>) {
    super();
    this.bridgeUrl =
      config?.bridgeUrl ??
      process.env.HERMIT_BRIDGE_WS_URL ??
      process.env.CC_CONNECT_BRIDGE_URL ??
      HERMIT_BRIDGE_DEFAULTS.bridgeUrl;
    this.token = (
      config?.bridgeToken ??
      config?.token ??
      process.env.HERMIT_BRIDGE_WS_TOKEN ??
      process.env.CC_CONNECT_BRIDGE_TOKEN ??
      process.env.HERMIT_BRIDGE_TOKEN ??
      process.env.HERMIT_BRIDGE_MANAGEMENT_TOKEN ??
      process.env.CC_CONNECT_TOKEN ??
      ''
    ).trim();
  }

  get connected(): boolean {
    return this._connected;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  start(): void {
    if (this._disposed) return;
    this.connect();
  }

  reconnect(): void {
    if (this._disposed) return;
    this._connected = false;
    this.cleanup();
    this.connect();
  }

  dispose(): void {
    this._disposed = true;
    this.cleanup();
  }

  // ===========================================================================
  // Send messages
  // ===========================================================================

  sendUserMessage(params: {
    sessionKey: string;
    userId: string;
    userName: string;
    content: string;
    msgId?: string;
    /** 显式路由到的 hermit-bridge project(群聊场景下必须指定) */
    project?: string;
    chatId?: string;
  }): void {
    const msg: HermitBridgeUserMessage = {
      type: 'message',
      msg_id: params.msgId ?? `hermit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      session_key: params.sessionKey,
      user_id: params.userId,
      user_name: params.userName,
      content: params.content,
      ...(params.project ? { project: params.project } : {}),
      ...(params.chatId ? { chat_id: params.chatId } : {}),
    };
    this.send(msg);
  }

  /**
   * 发送一条用户消息,等待匹配 sessionKey 的 reply 后返回。
   *
   * @param params 同 sendUserMessage
   * @param opts.timeoutMs 等待 reply 的超时(默认 180s)
   * @param opts.onEvent 期间收到的非 reply 事件(typing / reply_stream / card 等)
   */
  async sendAndWaitReply(
    params: Parameters<this['sendUserMessage']>[0],
    opts: {
      timeoutMs?: number;
      onEvent?: (msg: HermitBridgeIncomingMessage) => void;
    } = {}
  ): Promise<HermitBridgeReplyMessage> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    return new Promise<HermitBridgeReplyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 reply 超时(${timeoutMs}ms)`));
      }, timeoutMs);

      const onReply = (msg: HermitBridgeReplyMessage) => {
        if (msg.session_key && msg.session_key !== params.sessionKey) return;
        cleanup();
        resolve(msg);
      };
      const onAny = (msg: HermitBridgeIncomingMessage) => {
        if (
          (msg as { session_key?: string }).session_key !== undefined &&
          (msg as { session_key?: string }).session_key !== params.sessionKey
        )
          return;
        try {
          opts.onEvent?.(msg);
        } catch {
          /* ignore */
        }
      };
      const onStream = (msg: HermitBridgeReplyStreamMessage) => onAny(msg);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('reply', onReply);
        this.off('reply_stream', onStream);
        this.off('message', onAny);
      };
      this.on('reply', onReply);
      this.on('reply_stream', onStream);
      this.on('message', onAny);

      try {
        this.sendUserMessage(params);
      } catch (err) {
        cleanup();
        reject(err as Error);
      }
    });
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private connect(): void {
    if (this._disposed || this.ws) return;

    const url = this.token
      ? `${this.bridgeUrl}?token=${encodeURIComponent(this.token)}`
      : this.bridgeUrl;

    logger.info(`Connecting to hermit-bridge Bridge: ${this.bridgeUrl}`);

    const ws = (() => {
      try {
        return new WebSocket(url);
      } catch (error) {
        logger.warn(`Failed to create WebSocket: ${error}`);
        this.scheduleReconnect();
        return null;
      }
    })();
    if (!ws) return;
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      logger.info('Bridge WebSocket connected');
      this._connected = true;

      this.send({
        type: 'register',
        platform: 'hermit',
        capabilities: BRIDGE_CAPABILITIES,
        metadata: { version: '1.0.0' },
        observe_usage: true,
      });

      this.startPing();
      this.emit('connected');
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const msg = JSON.parse(data) as HermitBridgeIncomingMessage;
        this.handleIncomingMessage(msg);
      } catch (error) {
        logger.warn(`Failed to parse bridge message: ${error}`);
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      logger.info(`Bridge WebSocket closed: ${event.code} ${event.reason}`);
      if (this.ws !== ws) return;
      this.handleDisconnect();
    });

    ws.addEventListener('error', () => {
      logger.warn('Bridge WebSocket error');
      if (this.ws !== ws) return;
      this.handleDisconnect(new Error('WebSocket error'));
    });
  }

  private handleIncomingMessage(msg: HermitBridgeIncomingMessage): void {
    switch (msg.type) {
      case 'reply':
        this.emit('reply', msg);
        break;
      case 'reply_stream':
        this.emit('reply_stream', msg);
        break;
      case 'usage':
        this.emit('usage', msg);
        break;
      default:
        this.emit('message', msg);
        break;
    }
  }

  private send(msg: HermitBridgeOutgoingMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      logger.warn(`Cannot send message — Bridge WS not connected (type=${msg.type})`);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleDisconnect(error?: Error): void {
    this._connected = false;
    this.cleanup();
    this.emit('disconnected', error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this._disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // 先置空再 close：undici 的 WebSocket.close() 会同步派发 close/error 事件，
      // 监听器会回调 handleDisconnect()→cleanup()。先置空让监听器里的
      // `if (this.ws !== ws) return` 守卫命中，避免重入导致的栈溢出。
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  // ===========================================================================
  // Configuration update
  // ===========================================================================

  updateConfig(config: Partial<HermitBridgeConnectionConfig>): void {
    const changed =
      (config.bridgeUrl && config.bridgeUrl !== this.bridgeUrl) ||
      (config.bridgeToken !== undefined && config.bridgeToken !== this.token) ||
      (config.token !== undefined && config.token !== this.token);

    if (config.bridgeUrl) this.bridgeUrl = config.bridgeUrl;
    if (config.bridgeToken !== undefined) this.token = config.bridgeToken.trim();
    else if (config.token !== undefined) this.token = config.token.trim();

    if (changed) {
      this.cleanup();
      this.connect();
    }
  }
}

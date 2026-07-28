import type { FastifyBaseLogger } from 'fastify';

import type { ServerLifecycleState } from './serverContext';

export type ServerProcessTarget = Pick<
  NodeJS.Process,
  'emit' | 'exit' | 'listenerCount' | 'off' | 'on'
>;

interface ClosableServerApp {
  close(): Promise<unknown>;
  log: Pick<FastifyBaseLogger, 'error'>;
}

interface SseClientCollection {
  [Symbol.iterator](): IterableIterator<{ res: { end(): unknown } }>;
  clear(): void;
}

interface WorkbenchShutdownDependencies {
  app: ClosableServerApp;
  lifecycle: ServerLifecycleState;
  sseClients?: SseClientCollection;
  stopTelemetry?: () => Promise<void> | void;
  imLiveWatcher: { stop(): void };
  directCliManager: { shutdown(): void };
  bridgeLauncher: { stop(): void };
  bridge: { dispose?: () => void };
  closeTimeoutMs?: number;
}

interface ServerShutdownDependencies {
  shutdownWorkbenchServer(): Promise<void>;
  processTarget: ServerProcessTarget;
}

interface ServerProcessHandlerDependencies {
  app: Pick<ClosableServerApp, 'log'>;
  directCliManager: { shutdown(): void };
  processTarget: ServerProcessTarget;
  shutdown(): Promise<void>;
}

function closeTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs).unref();
  });
}

export function createWorkbenchShutdown({
  app,
  lifecycle,
  sseClients = new Set(),
  stopTelemetry = () => undefined,
  imLiveWatcher,
  directCliManager,
  bridgeLauncher,
  bridge,
  closeTimeoutMs = 3_000,
}: WorkbenchShutdownDependencies): () => Promise<void> {
  return () => {
    if (!lifecycle.disposePromise) {
      lifecycle.disposePromise = (async () => {
        for (const dispose of lifecycle.listenerDisposers.splice(0)) dispose();
        imLiveWatcher.stop();
        await stopTelemetry();
        for (const client of sseClients) {
          try {
            client.res.end();
          } catch {
            // Best-effort shutdown for already-closed renderer connections.
          }
        }
        sseClients.clear();
        directCliManager.shutdown();
        bridgeLauncher.stop();
        bridge.dispose?.();
        // Bound app.close() so a stuck SSE/websocket client cannot hold an
        // Electron or standalone process alive forever.
        await Promise.race([app.close(), closeTimeout(closeTimeoutMs)]);
      })();
    }
    return lifecycle.disposePromise;
  };
}

export function createServerShutdown({
  shutdownWorkbenchServer,
  processTarget,
}: ServerShutdownDependencies): () => Promise<void> {
  return async () => {
    try {
      await shutdownWorkbenchServer();
      processTarget.exit(0);
    } catch {
      processTarget.exit(1);
    }
  };
}

export function installServerProcessHandlers({
  app,
  directCliManager,
  processTarget,
  shutdown,
}: ServerProcessHandlerDependencies): () => void {
  const handleUnhandledRejection = (reason: unknown) => {
    app.log.error({ reason }, 'unhandledRejection (logged, not crashing)');
  };
  const handleSignal = () => {
    void shutdown();
  };
  const handleExit = () => {
    directCliManager.shutdown();
  };

  processTarget.on('unhandledRejection', handleUnhandledRejection);
  processTarget.on('SIGINT', handleSignal);
  processTarget.on('SIGTERM', handleSignal);
  processTarget.on('exit', handleExit);

  return () => {
    processTarget.off('unhandledRejection', handleUnhandledRejection);
    processTarget.off('SIGINT', handleSignal);
    processTarget.off('SIGTERM', handleSignal);
    processTarget.off('exit', handleExit);
  };
}

import type { FastifyBaseLogger } from 'fastify';

export type ServerProcessTarget = Pick<
  NodeJS.Process,
  'emit' | 'exit' | 'listenerCount' | 'off' | 'on'
>;

interface ClosableServerApp {
  close(): Promise<unknown>;
  log: Pick<FastifyBaseLogger, 'error'>;
}

interface ServerShutdownDependencies {
  app: ClosableServerApp;
  imLiveWatcher: { stop(): void };
  directCliManager: { shutdown(): void };
  bridgeLauncher: { stop(): void };
  bridge: { dispose?: () => void };
  processTarget: ServerProcessTarget;
  closeTimeoutMs?: number;
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

export function createServerShutdown({
  app,
  imLiveWatcher,
  directCliManager,
  bridgeLauncher,
  bridge,
  processTarget,
  closeTimeoutMs = 3_000,
}: ServerShutdownDependencies): () => Promise<void> {
  return async () => {
    try {
      imLiveWatcher.stop();
      directCliManager.shutdown();
      bridgeLauncher.stop();
      bridge.dispose?.();
      // Bound app.close() so a stuck SSE/websocket client cannot hold the
      // process alive forever. This intentionally preserves the standalone
      // server's existing three-second shutdown behavior.
      await Promise.race([app.close(), closeTimeout(closeTimeoutMs)]);
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

import type { ServerLifecycleState } from './serverContext';
import type { FastifyBaseLogger } from 'fastify';

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
  directCliManager: { shutdown(): Promise<void> | void };
  bridgeLauncher: { stop(): void };
  bridge: { dispose?: () => void };
  closeTimeoutMs?: number;
}

interface ServerShutdownDependencies {
  shutdownWorkbenchServer(): Promise<void>;
  processTarget: ServerProcessTarget;
  removeProcessHandlers?: () => void;
}

interface ServerProcessHandlerDependencies {
  app: Pick<ClosableServerApp, 'log'>;
  directCliManager: { shutdown(): Promise<void> | void };
  processTarget: ServerProcessTarget;
  shutdown(): Promise<void>;
}

function closeTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs).unref();
  });
}

async function attemptCleanup(errors: unknown[], cleanup: () => Promise<unknown> | unknown) {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
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
        const errors: unknown[] = [];
        // Invoke close immediately so Fastify stops accepting new requests.
        // Dependency cleanup waits until existing requests drain (or the bound
        // expires), so in-flight handlers retain their services.
        const appClosePromise = Promise.race([app.close(), closeTimeout(closeTimeoutMs)]);
        lifecycle.startupAbortController?.abort();
        lifecycle.startupAbortController = null;
        const startupTasks = Array.from(lifecycle.backgroundStartupTasks);
        if (startupTasks.length > 0) {
          await attemptCleanup(errors, () => Promise.allSettled(startupTasks));
        }
        lifecycle.backgroundStartupTasks.clear();
        await attemptCleanup(errors, () => appClosePromise);
        for (const dispose of lifecycle.listenerDisposers.splice(0)) {
          await attemptCleanup(errors, dispose);
        }
        await attemptCleanup(errors, () => imLiveWatcher.stop());
        await attemptCleanup(errors, stopTelemetry);
        for (const client of sseClients) {
          await attemptCleanup(errors, () => client.res.end());
        }
        sseClients.clear();
        await attemptCleanup(errors, () => directCliManager.shutdown());
        await attemptCleanup(errors, () => bridgeLauncher.stop());
        await attemptCleanup(errors, () => bridge.dispose?.());
        if (errors.length > 0) {
          throw new AggregateError(errors, 'workbench shutdown completed with errors');
        }
      })();
    }
    return lifecycle.disposePromise;
  };
}

export function createServerShutdown({
  shutdownWorkbenchServer,
  processTarget,
  removeProcessHandlers = () => undefined,
}: ServerShutdownDependencies): () => Promise<void> {
  return async () => {
    try {
      await shutdownWorkbenchServer();
      removeProcessHandlers();
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
    void directCliManager.shutdown();
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

/**
 * Hermit standalone workbench server process entry.
 *
 * The reusable factory lives in workbenchServer.ts and never listens on import.
 * This file only loads standalone composition and starts the process when
 * executed directly.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type { StandaloneServerHandle, StartStandaloneServerOptions } from './serverStandalone';
export type { WorkbenchServer, WorkbenchServerOptions } from './workbenchServer';
export { createWorkbenchServer } from './workbenchServer';

import type { StandaloneServerHandle, StartStandaloneServerOptions } from './serverStandalone';

export async function startStandaloneServer(
  options: StartStandaloneServerOptions = {}
): Promise<StandaloneServerHandle> {
  const standalone = await import('./serverStandalone');
  return standalone.startStandaloneServer(options);
}

export function isDirectServerExecution(
  moduleUrl: string,
  argvEntry: string | undefined = process.argv[1]
): boolean {
  if (!argvEntry) return false;
  return moduleUrl === pathToFileURL(path.resolve(argvEntry)).href;
}

if (isDirectServerExecution(import.meta.url)) {
  await startStandaloneServer();
}

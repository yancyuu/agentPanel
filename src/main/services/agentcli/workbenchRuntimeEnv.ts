import { buildMergedCliPath } from '@main/utils/cliPathMerge';

export function resolveLoopbackWorkbenchUrl(host: string, port: number): string {
  const normalizedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlHost = normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost;
  return `http://${urlHost}:${port}`;
}

export function buildWorkbenchRuntimeEnv({
  workbenchUrl,
  baseEnv = process.env,
}: {
  workbenchUrl: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PATH: buildMergedCliPath(null),
    HERMIT_WORKBENCH_URL: workbenchUrl,
  };
}

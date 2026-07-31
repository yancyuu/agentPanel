import path from 'node:path';

import {
  buildDesktopServerEnvironment,
  DESKTOP_TELEMETRY_RECONCILE_ARGS,
  isAllowedExternalUrl,
  isAllowedWorkbenchNavigation,
  resolveDesktopRuntimePaths,
} from '../../src/desktop/runtime';
import { describe, expect, it } from 'vitest';

describe('desktop runtime composition', () => {
  it('resolves packaged resources outside app.asar', () => {
    expect(
      resolveDesktopRuntimePaths({
        isPackaged: true,
        appPath: '/Applications/AgentCLI.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/AgentCLI.app/Contents/Resources',
      })
    ).toEqual({
      appRoot: '/Applications/AgentCLI.app/Contents/Resources/app.asar',
      runtimeRoot: '/Applications/AgentCLI.app/Contents/Resources/agentcli',
      serverEntry: '/Applications/AgentCLI.app/Contents/Resources/agentcli/dist/server.bundle.mjs',
      staticDir: '/Applications/AgentCLI.app/Contents/Resources/agentcli/dist-renderer',
      cliEntry: '/Applications/AgentCLI.app/Contents/Resources/agentcli/bin/agentcli.mjs',
    });
  });

  it('reconciles an already-enabled telemetry worker without mutating user consent', () => {
    expect(DESKTOP_TELEMETRY_RECONCILE_ARGS).toEqual(['usage', 'reconcile', '--json']);
  });

  it('forces the embedded server onto loopback and ignores ambient host/port values', () => {
    const environment = buildDesktopServerEnvironment({
      baseEnvironment: { HOST: '0.0.0.0', PORT: '9999', PATH: '/usr/bin' },
      port: 57123,
      sessionToken: 'secret-session',
      staticDir: '/runtime/dist-renderer',
      runtimeRoot: '/runtime',
      hermitHome: path.join('/Users/test', '.hermit'),
    });
    expect(environment).toMatchObject({
      HOST: '127.0.0.1',
      PORT: '57123',
      STATIC_DIR: '/runtime/dist-renderer',
      AGENTCLI_PACKAGE_ROOT: '/runtime',
      AGENTCLI_DESKTOP_SESSION_TOKEN: 'secret-session',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: `${path.join('/Users/test', '.hermit', 'bin')}${path.delimiter}/usr/bin`,
      CORS_ORIGIN: 'http://127.0.0.1:57123',
    });
  });

  it('allows only the exact workbench origin and normal external web links', () => {
    const origin = 'http://127.0.0.1:57123';
    expect(isAllowedWorkbenchNavigation(`${origin}/tasks`, origin)).toBe(true);
    expect(isAllowedWorkbenchNavigation('http://127.0.0.1:57124/tasks', origin)).toBe(false);
    expect(isAllowedWorkbenchNavigation('https://example.com', origin)).toBe(false);
    expect(isAllowedExternalUrl('https://example.com/help')).toBe(true);
    expect(isAllowedExternalUrl('file:///tmp/secret')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

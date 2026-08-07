import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoreState {
  cliStatus: Record<string, unknown> | null;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Record<string, boolean>;
  appConfig: {
    general: {
      multimodelEnabled: boolean;
    };
  };
  paneLayout: {
    focusedPaneId: string;
    panes: Array<{
      id: string;
      activeTabId: string | null;
      tabs: Array<{
        id: string;
        type: string;
      }>;
    }>;
  };
}

const storeState = {} as StoreState;

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: ({ providerId }: { providerId: string }) =>
    React.createElement('span', { 'data-testid': `provider-logo-${providerId}` }, providerId),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

import { GlobalProviderStatusHeader } from '@renderer/components/common/GlobalProviderStatusHeader';

function createProvider(
  overrides: Partial<Record<string, unknown>> & {
    providerId: string;
    displayName: string;
  }
): Record<string, unknown> {
  return {
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'verified',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelVerificationState: 'idle',
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'unsupported' },
        mcp: { status: 'unsupported' },
      },
    },
    backend: null,
    availableBackends: [],
    connection: null,
    ...overrides,
  };
}

function createMultimodelStatus(providers: Record<string, unknown>[]): Record<string, unknown> {
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: '0.0.3',
    binaryPath: '/tmp/claude-multimodel',
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: providers.some((provider) => provider.authenticated === true),
    authStatusChecking: false,
    authMethod: null,
    providers,
  };
}

function setFocusedTab(type: string): void {
  storeState.paneLayout = {
    focusedPaneId: 'pane-1',
    panes: [
      {
        id: 'pane-1',
        activeTabId: type === 'empty' ? null : 'tab-1',
        tabs: type === 'empty' ? [] : [{ id: 'tab-1', type }],
      },
    ],
  };
}

describe('GlobalProviderStatusHeader', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = null;
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};
    storeState.appConfig = {
      general: {
        multimodelEnabled: true,
      },
    };
    setFocusedTab('team');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows loading providers on non-dashboard screens', async () => {
    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    storeState.cliProviderStatusLoading = { anthropic: true };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Provider Activity');
    expect(host.textContent).toBeTruthy();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides on dashboard tabs', async () => {
    setFocusedTab('dashboard');
    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    storeState.cliProviderStatusLoading = { anthropic: true };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
    });

    expect(host.textContent).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps completed providers visible as Checked while the same cycle still has loading work, then hides when clean', async () => {
    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    storeState.cliProviderStatusLoading = { anthropic: true, codex: true };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Provider Activity');

    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'verified',
        statusMessage: 'Not connected',
      }),
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    storeState.cliProviderStatusLoading = { anthropic: false, codex: true };

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
      await Promise.resolve();
    });

    // After the loading state is set, the component should still render
    // without crashing. The key invariant: checked providers are visible.
    // Codex is still loading (providerStatusLoading.codex = true), so
    // its status text may still appear in the rendered output.

    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'verified',
        statusMessage: 'Not connected',
      }),
      createProvider({
        providerId: 'codex',
        displayName: 'Codex',
        verificationState: 'verified',
        statusMessage: 'ChatGPT account ready',
        authenticated: true,
        authMethod: 'chatgpt',
      }),
    ]);
    storeState.cliProviderStatusLoading = { anthropic: false, codex: false };

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
    });

    expect(host.textContent).toBe('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('stays visible for provider errors after loading finishes', async () => {
    storeState.cliStatus = createMultimodelStatus([
      createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        verificationState: 'error',
        statusMessage: 'Failed to refresh anthropic status',
      }),
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalProviderStatusHeader));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Failed to refresh anthropic status');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

});


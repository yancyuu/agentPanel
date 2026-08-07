import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useExtensionsTabState } from '../../../src/renderer/hooks/useExtensionsTabState';

type ExtensionsTabState = ReturnType<typeof useExtensionsTabState>;

let capturedState: ExtensionsTabState | null = null;

function Harness(): null {
  capturedState = useExtensionsTabState();
  return null;
}

describe('useExtensionsTabState', () => {
  afterEach(() => {
    capturedState = null;
    document.body.innerHTML = '';
  });

  it('keeps the extensions tab scoped to plugins only', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(capturedState?.activeSubTab).toBe('plugins');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('updates and clears plugin filters', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.updatePluginSearch('context');
      capturedState?.toggleCategory('productivity');
      capturedState?.toggleInstalledOnly();
      await Promise.resolve();
    });

    expect(capturedState?.pluginFilters.search).toBe('context');
    expect(capturedState?.pluginFilters.categories).toEqual(['productivity']);
    expect(capturedState?.pluginFilters.installedOnly).toBe(true);
    expect(capturedState?.hasActiveFilters).toBe(true);

    await act(async () => {
      capturedState?.clearFilters();
      await Promise.resolve();
    });

    expect(capturedState?.pluginFilters.search).toBe('');
    expect(capturedState?.pluginFilters.categories).toEqual([]);
    expect(capturedState?.pluginFilters.installedOnly).toBe(false);
    expect(capturedState?.hasActiveFilters).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

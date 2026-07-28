import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
  const clearPendingSettingsSection = vi.fn();
  const handlers = {
    handleGeneralToggle: vi.fn(),
    handleThemeChange: vi.fn(),
    handleLanguageChange: vi.fn(),
    handleResetToDefaults: vi.fn(),
    handleExportConfig: vi.fn(),
    handleImportConfig: vi.fn(),
    handleOpenInEditor: vi.fn(),
  };
  const safeConfig = { theme: 'system' };
  const mountedProps: {
    general?: Record<string, unknown>;
    advanced?: Record<string, unknown>;
  } = {};
  const store = {
    pendingSettingsSection: null as string | null,
    clearPendingSettingsSection,
  };
  return {
    clearPendingSettingsSection,
    handlers,
    safeConfig,
    mountedProps,
    store,
    loading: false,
  };
});

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof testState.store) => unknown) => selector(testState.store),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T): T => selector,
}));

vi.mock('./hooks', () => ({
  useSettingsConfig: () => ({
    config: testState.loading ? null : { theme: 'system' },
    safeConfig: testState.safeConfig,
    loading: testState.loading,
    saving: true,
    error: null,
    setError: vi.fn(),
    setSaving: vi.fn(),
    setConfig: vi.fn(),
    setOptimisticConfig: vi.fn(),
    updateConfig: vi.fn(),
  }),
  useSettingsHandlers: () => testState.handlers,
}));

/* eslint-disable @typescript-eslint/naming-convention -- mocked module exports retain production component names */
vi.mock('./sections', () => ({
  GeneralSection: (props: Record<string, unknown>) => {
    testState.mountedProps.general = props;
    return <div data-testid="general-section">通用内容</div>;
  },
  HarnessSection: () => <div data-testid="harness-section">Harness 内容</div>,
  AdvancedSection: (props: Record<string, unknown>) => {
    testState.mountedProps.advanced = props;
    return <div data-testid="advanced-section">高级内容</div>;
  },
}));

vi.mock('./sections/TaskBusSection', () => ({
  TaskBusSection: () => <div data-testid="task-bus-section">Usage 内容</div>,
}));
/* eslint-enable @typescript-eslint/naming-convention -- production naming checks resume below */

import { SettingsView } from './SettingsView';

class MockResizeObserver {
  static readonly instances: MockResizeObserver[] = [];

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}

  emit(width: number): void {
    this.callback(
      [
        {
          contentRect: { width },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
}

async function renderSettings(
  width = 960
): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SettingsView />);
    await Promise.resolve();
  });
  const observer = MockResizeObserver.instances.at(-1);
  if (!observer) throw new Error('SettingsView did not create ResizeObserver');
  await act(async () => {
    observer.emit(width);
    await Promise.resolve();
  });
  return { host, root };
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

async function clickCategory(host: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    findButton(host, label).click();
    await Promise.resolve();
  });
}

async function pressCategoryKey(
  host: HTMLElement,
  label: string,
  key: string
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    const button = findButton(host, label);
    button.focus();
    button.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('SettingsView navigation and layout', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    MockResizeObserver.instances.length = 0;
    testState.loading = false;
    testState.store.pendingSettingsSection = null;
    testState.clearPendingSettingsSection.mockReset();
    testState.clearPendingSettingsSection.mockImplementation(() => {
      testState.store.pendingSettingsSection = null;
    });
    testState.mountedProps.general = undefined;
    testState.mountedProps.advanced = undefined;
    Object.values(testState.handlers).forEach((handler) => handler.mockClear());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders four categories and switches the conditionally mounted content', async () => {
    const { host, root } = await renderSettings();
    const tabs = host.querySelectorAll('[role="tab"]');

    expect(tabs).toHaveLength(4);
    expect(Array.from(tabs).map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('通用'),
      expect.stringContaining('Harness'),
      expect.stringContaining('Usage 监测'),
      expect.stringContaining('高级'),
    ]);
    expect(findButton(host, '通用').getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[data-testid="general-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="harness-section"]')).toBeNull();

    await pressCategoryKey(host, '通用', 'ArrowDown');
    expect(findButton(host, 'Harness').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(findButton(host, 'Harness'));
    expect(host.querySelector('[data-testid="general-section"]')).toBeNull();
    expect(host.querySelector('[data-testid="harness-section"]')).not.toBeNull();
    expect(host.querySelector('[role="tabpanel"] h2')?.textContent).toBe('Harness');

    await clickCategory(host, 'Usage 监测');
    expect(host.querySelector('[data-testid="task-bus-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="harness-section"]')).toBeNull();

    await clickCategory(host, '高级');
    expect(host.querySelector('[data-testid="advanced-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task-bus-section"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it.each([
    ['general', 'general-section'],
    ['harness', 'harness-section'],
    ['task-bus', 'task-bus-section'],
    ['advanced', 'advanced-section'],
  ])('consumes pending section %s and clears it once', async (section, testId) => {
    testState.store.pendingSettingsSection = section;
    const { host, root } = await renderSettings();

    expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    expect(testState.clearPendingSettingsSection).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<SettingsView />);
      await Promise.resolve();
    });
    expect(testState.clearPendingSettingsSection).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('falls back to general for an unknown pending section and clears once', async () => {
    testState.store.pendingSettingsSection = 'unknown-section';
    const { host, root } = await renderSettings();

    expect(host.querySelector('[data-testid="general-section"]')).not.toBeNull();
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');
    expect(testState.clearPendingSettingsSection).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('attaches pane-width observation after the loading state resolves', async () => {
    testState.loading = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<SettingsView />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain('正在加载设置');
    expect(MockResizeObserver.instances).toHaveLength(0);

    testState.loading = false;
    await act(async () => {
      root.render(<SettingsView />);
      await Promise.resolve();
    });
    expect(MockResizeObserver.instances).toHaveLength(1);

    await act(async () => {
      MockResizeObserver.instances[0]?.emit(560);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-settings-layout="compact"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('uses a pane-width compact selector without page-level horizontal scrolling', async () => {
    const { host, root } = await renderSettings(560);
    const page = host.querySelector<HTMLElement>('[data-settings-layout="compact"]');
    const tabList = host.querySelector<HTMLElement>('[role="tablist"]');

    expect(page).not.toBeNull();
    expect(page?.className).toContain('overflow-x-hidden');
    expect(tabList?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(tabList?.className).toContain('overflow-x-auto');
    expect(host.querySelector('[role="tabpanel"]')?.className).toContain('min-w-0');

    await act(async () => root.unmount());
  });

  it('uses vertical arrow keys with wrapping, Home, and End without consuming horizontal arrows', async () => {
    const { host, root } = await renderSettings();
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe(
      'vertical'
    );

    const irrelevantEvent = await pressCategoryKey(host, '通用', 'ArrowRight');
    expect(irrelevantEvent.defaultPrevented).toBe(false);
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    expect((await pressCategoryKey(host, '通用', 'ArrowUp')).defaultPrevented).toBe(true);
    expect(findButton(host, '高级').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(findButton(host, '高级'));

    await pressCategoryKey(host, '高级', 'ArrowDown');
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    await pressCategoryKey(host, '通用', 'End');
    expect(findButton(host, '高级').getAttribute('aria-selected')).toBe('true');

    await pressCategoryKey(host, '高级', 'Home');
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    await act(async () => root.unmount());
  });

  it('uses horizontal arrow keys with wrapping, Home, and End without consuming vertical arrows', async () => {
    const { host, root } = await renderSettings(560);
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe(
      'horizontal'
    );

    const irrelevantEvent = await pressCategoryKey(host, '通用', 'ArrowDown');
    expect(irrelevantEvent.defaultPrevented).toBe(false);
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    expect((await pressCategoryKey(host, '通用', 'ArrowLeft')).defaultPrevented).toBe(true);
    expect(findButton(host, '高级').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(findButton(host, '高级'));

    await pressCategoryKey(host, '高级', 'ArrowRight');
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    await pressCategoryKey(host, '通用', 'End');
    expect(findButton(host, '高级').getAttribute('aria-selected')).toBe('true');

    await pressCategoryKey(host, '高级', 'Home');
    expect(findButton(host, '通用').getAttribute('aria-selected')).toBe('true');

    await act(async () => root.unmount());
  });

  it('keeps every tab control target stable while only mounting the active section', async () => {
    const { host, root } = await renderSettings();
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

    expect(panels).toHaveLength(4);
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).not.toBeNull();
      const panel = panelId ? host.querySelector<HTMLElement>(`#${panelId}`) : null;
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    const generalPanel = host.querySelector<HTMLElement>('#settings-panel-general');
    expect(generalPanel?.hidden).toBe(false);
    expect(generalPanel?.querySelector('[data-testid="general-section"]')).not.toBeNull();
    for (const section of ['harness', 'task-bus', 'advanced']) {
      const panel = host.querySelector<HTMLElement>(`#settings-panel-${section}`);
      expect(panel?.hidden).toBe(true);
      expect(panel?.children).toHaveLength(0);
    }
    expect(host.querySelector('[data-testid="harness-section"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-bus-section"]')).toBeNull();
    expect(host.querySelector('[data-testid="advanced-section"]')).toBeNull();

    await clickCategory(host, 'Harness');
    expect(generalPanel?.hidden).toBe(true);
    expect(generalPanel?.children).toHaveLength(0);
    const harnessPanel = host.querySelector<HTMLElement>('#settings-panel-harness');
    expect(harnessPanel?.hidden).toBe(false);
    expect(harnessPanel?.querySelector('[data-testid="harness-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="general-section"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it('preserves section mount and handler prop wiring', async () => {
    const { host, root } = await renderSettings();

    expect(testState.mountedProps.general).toMatchObject({
      safeConfig: testState.safeConfig,
      saving: true,
      onGeneralToggle: testState.handlers.handleGeneralToggle,
      onThemeChange: testState.handlers.handleThemeChange,
      onLanguageChange: testState.handlers.handleLanguageChange,
    });

    await clickCategory(host, '高级');
    expect(testState.mountedProps.advanced).toMatchObject({
      saving: true,
      onResetToDefaults: testState.handlers.handleResetToDefaults,
      onExportConfig: testState.handlers.handleExportConfig,
      onImportConfig: testState.handlers.handleImportConfig,
      onOpenInEditor: testState.handlers.handleOpenInEditor,
    });

    await clickCategory(host, 'Harness');
    expect(host.querySelector('[data-testid="harness-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="advanced-section"]')).toBeNull();

    await clickCategory(host, 'Usage 监测');
    expect(host.querySelector('[data-testid="task-bus-section"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="harness-section"]')).toBeNull();

    await act(async () => root.unmount());
  });
});

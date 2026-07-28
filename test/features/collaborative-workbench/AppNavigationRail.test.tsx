import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppNavigationRail,
  getWorkbenchNavigationArea,
} from '@features/collaborative-workbench/renderer';

import type { AppNavigationRailProps } from '@features/collaborative-workbench/renderer';

function createProps(overrides: Partial<AppNavigationRailProps> = {}): AppNavigationRailProps {
  return {
    activeArea: 'inbox',
    unreadCount: 3,
    onOpenInbox: vi.fn(),
    onOpenOverview: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenSchedules: vi.fn(),
    onOpenExtensions: vi.fn(),
    onOpenNotifications: vi.fn(),
    onOpenSystemManager: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenCommunity: vi.fn(),
    ...overrides,
  };
}

async function renderRail(props: AppNavigationRailProps) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AppNavigationRail {...props} />);
    await Promise.resolve();
  });
  return { host, root };
}

function click(host: HTMLElement, label: string): void {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('AppNavigationRail', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('maps every existing tab family to the correct application area', () => {
    expect(getWorkbenchNavigationArea({ type: 'tasks' })).toBe('inbox');
    expect(getWorkbenchNavigationArea({ type: 'dashboard' })).toBe('overview');
    expect(getWorkbenchNavigationArea({ type: 'session' })).toBe('overview');
    expect(getWorkbenchNavigationArea({ type: 'report' })).toBe('overview');
    expect(getWorkbenchNavigationArea({ type: 'chat' })).toBe('community');
    expect(getWorkbenchNavigationArea({ type: 'teams' })).toBe('agents');
    expect(getWorkbenchNavigationArea({ type: 'team', teamName: '研发团队' })).toBe('agents');
    expect(getWorkbenchNavigationArea({ type: 'team', teamName: 'system-manager' })).toBe(
      'system-manager'
    );
    expect(getWorkbenchNavigationArea({ type: 'graph' })).toBe('agents');
    expect(getWorkbenchNavigationArea({ type: 'schedules' })).toBe('schedules');
    expect(getWorkbenchNavigationArea({ type: 'extensions' })).toBe('extensions');
    expect(getWorkbenchNavigationArea({ type: 'notifications' })).toBe('notifications');
    expect(getWorkbenchNavigationArea({ type: 'settings' })).toBe('settings');
    expect(getWorkbenchNavigationArea(null)).toBeNull();
  });

  it('shows the community entry as active for the existing chat tab area', async () => {
    const { host, root } = await renderRail(createProps({ activeArea: 'community' }));

    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      '加入飞书群'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('invokes existing navigation actions and exposes the active item', async () => {
    const props = createProps();
    const { host, root } = await renderRail(props);

    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('收件箱');
    expect(host.textContent).toContain('3');

    click(host, '收件箱');
    click(host, '概览');
    click(host, '数字员工');
    click(host, '定时任务');
    click(host, '扩展');
    click(host, '通知');
    click(host, 'Helm Loop');
    click(host, '设置');
    click(host, '搜索');
    click(host, '加入飞书群');

    expect(props.onOpenInbox).toHaveBeenCalledOnce();
    expect(props.onOpenOverview).toHaveBeenCalledOnce();
    expect(props.onOpenAgents).toHaveBeenCalledOnce();
    expect(props.onOpenSchedules).toHaveBeenCalledOnce();
    expect(props.onOpenExtensions).toHaveBeenCalledOnce();
    expect(props.onOpenNotifications).toHaveBeenCalledOnce();
    expect(props.onOpenSystemManager).toHaveBeenCalledOnce();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(props.onOpenSearch).toHaveBeenCalledOnce();
    expect(props.onOpenCommunity).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

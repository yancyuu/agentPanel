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
    inboxHasUnread: true,
    onOpenInbox: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenOverview: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenCollaboration: vi.fn(),
    onOpenSchedules: vi.fn(),
    onOpenSystemManager: vi.fn(),
    onOpenSettings: vi.fn(),
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
    expect(getWorkbenchNavigationArea({ type: 'inbox' })).toBe('inbox');
    expect(getWorkbenchNavigationArea({ type: 'tasks' })).toBe('tasks');
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
    expect(getWorkbenchNavigationArea({ type: 'collaboration' })).toBe('collaboration');
    expect(getWorkbenchNavigationArea({ type: 'schedules' })).toBe('schedules');
    expect(getWorkbenchNavigationArea({ type: 'extensions' })).toBe('extensions');
    expect(getWorkbenchNavigationArea({ type: 'notifications' })).toBe('notifications');
    expect(getWorkbenchNavigationArea({ type: 'settings' })).toBe('settings');
    expect(getWorkbenchNavigationArea(null)).toBeNull();
  });

  it('shows a task-feedback dot outside the inbox and hides it while the inbox is open', async () => {
    const outside = await renderRail(createProps({ activeArea: 'overview' }));
    expect(outside.host.querySelector('[aria-label="有新任务反馈"]')).not.toBeNull();
    await act(async () => {
      outside.root.unmount();
      await Promise.resolve();
    });

    const inside = await renderRail(createProps({ activeArea: 'inbox' }));
    expect(inside.host.querySelector('[aria-label="有新任务反馈"]')).toBeNull();
    await act(async () => {
      inside.root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps overview and diagnostics visible while hiding low-value entries', async () => {
    const { host, root } = await renderRail(createProps({ activeArea: 'overview' }));

    expect(host.querySelector('[aria-label="概览"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="诊断"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="通知"]')).toBeNull();
    expect(host.querySelector('[aria-label="定时任务"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="扩展能力"]')).toBeNull();
    expect(host.querySelector('[aria-label="搜索"]')).toBeNull();
    expect(host.querySelector('[aria-label="加入飞书群"]')).toBeNull();
    expect(host.querySelector('.lucide-circle-help')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('invokes existing navigation actions and exposes the active item', async () => {
    const props = createProps();
    const { host, root } = await renderRail(props);

    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe('收件箱');
    expect(host.querySelector('[aria-label="有新任务反馈"]')).toBeNull();

    click(host, '概览');
    click(host, '收件箱');
    click(host, '任务');
    click(host, '定时任务');
    click(host, '智能体');
    click(host, '小队');
    click(host, '诊断');
    click(host, '设置');

    expect(props.onOpenInbox).toHaveBeenCalledOnce();
    expect(props.onOpenTasks).toHaveBeenCalledOnce();
    expect(props.onOpenOverview).toHaveBeenCalledOnce();
    expect(props.onOpenSchedules).toHaveBeenCalledOnce();
    expect(props.onOpenAgents).toHaveBeenCalledOnce();
    expect(props.onOpenCollaboration).toHaveBeenCalledOnce();
    expect(props.onOpenSystemManager).toHaveBeenCalledOnce();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

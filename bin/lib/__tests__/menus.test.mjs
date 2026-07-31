// menus.test.mjs — asserts the interactive menu exposes the actions users
// actually need. The scan action re-reports the last 24h only ("只上报最近 24
// 小时"): it ignores the server cursor and relies on eventId dedup. Pure data
// assertions against menus.mjs.
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ACTIONS,
  LOCAL_COLLECTION_ACTIONS,
  LOCAL_USE_ACTIONS,
  NAV_ACTIONS,
  SERVICE_ACTIONS,
  TASK_BUS_ACTIONS,
  TEAM_COLLAB_ACTIONS,
  findMenuAction,
} from '../menus.mjs';

describe('menus — scan action re-reports the last 24h', () => {
  it('data-sync nav group offers a 重报最近 7 天 action', () => {
    const dataSync = NAV_ACTIONS.find((a) => a.id === 'data-sync');
    expect(dataSync, 'data-sync nav group must exist').toBeTruthy();
    const scan = dataSync.children.find((c) => c.id === 'scan');
    expect(scan, 'data-sync must have a scan child').toBeTruthy();
    // The all-history 全量上报 label is gone; the action now targets last 7 days.
    expect(scan.label).toMatch(/重报/);
    expect(scan.label).toMatch(/7 天/);
    expect(scan.label).not.toMatch(/全量/);
  });

  it('local-collection menu offers the same 重报最近 7 天 action', () => {
    const scan = findMenuAction(LOCAL_COLLECTION_ACTIONS, 'scan');
    expect(scan, 'local-collection must have a scan action').toBeTruthy();
    expect(scan.label).toMatch(/重报/);
    expect(scan.label).not.toMatch(/全量/);
  });
});

describe('menus — 桌面客户端取代 CLI Web 工作台入口', () => {
  it('removes Web workbench actions from every interactive menu', () => {
    expect(NAV_ACTIONS.map((action) => action.id)).not.toContain('web');
    expect(
      NAV_ACTIONS.flatMap((action) => action.children ?? []).map((action) => action.id)
    ).not.toEqual(expect.arrayContaining(['toggle-web', 'workbench-status']));
    expect(SERVICE_ACTIONS.map((action) => action.id)).not.toEqual(
      expect.arrayContaining(['start-local', 'start-web', 'stop-web'])
    );
    expect(LOCAL_USE_ACTIONS.map((action) => action.id)).not.toContain('web');
    expect(TEAM_COLLAB_ACTIONS.map((action) => action.id)).not.toContain('open-web-settings');
    expect(TASK_BUS_ACTIONS.map((action) => action.id)).not.toContain('open-web-settings');
  });
});

describe('menus — 用户菜单不重复提供在线说明书', () => {
  it('keeps login and account controls only', () => {
    const ids = ACCOUNT_ACTIONS.map((action) => action.id);

    expect(ids).toEqual(['login', 'status', 'logout', 'back']);
    expect(ids).not.toContain('guide');
  });

  it('combines the online guide and local token-pool diagnostic into one manual action', () => {
    const manual = findMenuAction(
      NAV_ACTIONS.find((action) => action.id === 'aikey').children,
      'aikey-manual'
    );

    expect(manual).toBeTruthy();
    expect(manual.label).toBe('说明书');
    expect(manual.description).toContain('在线说明书');
    expect(manual.description).toContain('本地脱敏配置');
  });

  it('does not expose digital worker onboarding from the user account group', () => {
    const account = NAV_ACTIONS.find((a) => a.id === 'account');
    const action = findMenuAction(account.children, 'quick-create-assistant');

    expect(action).toBeNull();
  });
});

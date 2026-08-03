import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

vi.mock('@renderer/api', () => ({
  api: {
    ccSetup: {
      feishuBegin: vi.fn(async () => ({
        device_code: 'device-1',
        qr_url: 'https://example.com/qr',
        interval: 0,
      })),
      feishuPoll: vi.fn(async () => ({
        status: 'completed',
        app_id: 'app-id',
        app_secret: 'app-secret',
        platform: 'lark',
        owner_open_id: 'owner-open-id',
      })),
      feishuSave: vi.fn(async () => ({ message: 'saved', restart_required: false })),
      weixinBegin: vi.fn(async () => ({
        qr_key: 'qr-key',
        qr_url: 'https://example.com/weixin',
        api_url: 'https://weixin-api.example.com',
      })),
      weixinPoll: vi.fn(async () => ({
        status: 'confirmed',
        bot_token: 'bot-token',
      })),
      weixinSave: vi.fn(async () => ({ message: 'saved', restart_required: false })),
    },
    ccSettings: { restart: vi.fn(async () => undefined) },
  },
}));

import PlatformSetupQR from '@renderer/components/team/dialogs/PlatformSetupQR';
import { api } from '@renderer/api';

async function renderQr(platformType: 'feishu' | 'lark' | 'weixin', onComplete = vi.fn()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <PlatformSetupQR
        platformType={platformType}
        projectName="test-project"
        workDir="/repo"
        agentType="claudecode"
        onComplete={onComplete}
        onCancel={vi.fn()}
      />
    );
  });
  const startButton = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('开始扫码绑定')
  );
  // 主按钮显式 accent（浅色主题下不再是「看不见的白色按钮」）
  expect(startButton?.className).toContain('bg-[var(--color-accent)]');
  expect(startButton?.className).toContain('text-white');
  await act(async () => {
    startButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root, onComplete };
}

describe('PlatformSetupQR', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('polls Weixin with the API URL returned by begin', async () => {
    const { root } = await renderQr('weixin');

    expect(api.ccSetup.weixinPoll).toHaveBeenCalledWith(
      'qr-key',
      'https://weixin-api.example.com'
    );
    await act(async () => root.unmount());
  });

  it.each([
    ['feishu', 'feishuSave'],
    ['weixin', 'weixinSave'],
  ] as const)('passes restartHandled true without restarting for %s', async (platformType, saveMethod) => {
    vi.mocked(api.ccSetup[saveMethod]).mockResolvedValueOnce({
      message: 'saved',
      restart_required: true,
      restart_handled: true,
    });
    const { host, root, onComplete } = await renderQr(platformType);

    expect(api.ccSettings.restart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('服务已重启并刷新平台长连接');

    const completeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('完成')
    );
    await act(async () => {
      completeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      completeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ restartHandled: true });
    expect(api.ccSettings.restart).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it.each([
    ['lark', 'feishuSave'],
    ['weixin', 'weixinSave'],
  ] as const)('passes restartHandled false and requests parent restart for %s', async (platformType, saveMethod) => {
    vi.mocked(api.ccSetup[saveMethod]).mockResolvedValueOnce({
      message: 'saved',
      restart_required: true,
      restart_handled: false,
    });
    const { host, root, onComplete } = await renderQr(platformType);

    expect(api.ccSettings.restart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('下一步将统一重启服务并刷新平台长连接');
    const completeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重启并完成')
    );
    await act(async () => completeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(onComplete).toHaveBeenCalledWith({ restartHandled: false });
    await act(async () => root.unmount());
  });
});

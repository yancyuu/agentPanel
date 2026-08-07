import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock sub-components using full resolved paths
vi.mock('@renderer/components/team/dialogs/PlatformSetupQR', () => ({
  default: ({
    projectName,
    platformType,
    onComplete,
    onCancel,
  }: {
    projectName: string;
    platformType: string;
    onComplete: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="qr-setup" data-project={projectName} data-platform={platformType}>
      <button data-testid="qr-complete" onClick={onComplete}>QR Done</button>
      <button data-testid="qr-cancel" onClick={onCancel}>QR Back</button>
    </div>
  ),
}));

vi.mock('@renderer/components/team/dialogs/PlatformManualForm', () => ({
  default: ({
    platformType,
    onComplete,
    onCancel,
  }: {
    platformType: string;
    onComplete: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="manual-form" data-platform={platformType}>
      <button data-testid="form-complete" onClick={onComplete}>Form Done</button>
      <button data-testid="form-cancel" onClick={onCancel}>Form Back</button>
    </div>
  ),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { PlatformBindingContent } from '@renderer/components/team/dialogs/PlatformBindingDialog';

describe('PlatformBindingContent', () => {
  const defaultProps = {
    projectName: 'test-project',
    workDir: '/repo',
    agentType: 'claudecode',
    onComplete: vi.fn(),
    onCancel: vi.fn(),
  };

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders platform selection grid with grouped WeCom IM card', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('飞书');
    expect(host.textContent).toContain('微信');
    expect(host.textContent).toContain('Telegram');
    expect(host.textContent).toContain('Discord');
    expect(host.textContent).toContain('企业微信 / IM');
    expect(host.textContent).not.toContain('企业微信智能机器人');
    expect(host.textContent).not.toContain('企业微信自建应用（Callback）');
    expect(host.textContent).toContain('取消');

    await act(async () => {
      root.unmount();
    });
  });

  it('transitions to QR step when a QR platform is clicked', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const feishuBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('飞书'),
    );
    expect(feishuBtn).toBeTruthy();

    await act(async () => {
      feishuBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const qrSetup = host.querySelector('[data-testid="qr-setup"]');
    expect(qrSetup).toBeTruthy();
    expect(qrSetup?.getAttribute('data-project')).toBe('test-project');
    expect(qrSetup?.getAttribute('data-platform')).toBe('feishu');

    await act(async () => {
      root.unmount();
    });
  });

  it('transitions to form step when a manual platform is clicked', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const telegramBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Telegram'),
    );

    await act(async () => {
      telegramBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="manual-form"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="manual-form"]')?.getAttribute('data-platform')).toBe(
      'telegram',
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('opens WeCom mode selection from the grouped IM card', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const wecomBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信 / IM'),
    );

    await act(async () => {
      wecomBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('选择企业微信接入方式');
    expect(host.textContent).toContain('企业微信智能机器人');
    expect(host.textContent).toContain('企业微信自建应用（Callback）');
    expect(host.querySelector('[data-testid="manual-form"]')).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it('opens the WeCom websocket form after choosing intelligent robot mode', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const wecomBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信 / IM'),
    );
    await act(async () => {
      wecomBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const wsBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信智能机器人'),
    );
    await act(async () => {
      wsBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="manual-form"]')?.getAttribute('data-platform')).toBe(
      'wecom_ws',
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('opens the WeCom callback form after choosing self-built app mode', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const wecomBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信 / IM'),
    );
    await act(async () => {
      wecomBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const callbackBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信自建应用（Callback）'),
    );
    await act(async () => {
      callbackBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="manual-form"]')?.getAttribute('data-platform')).toBe(
      'wecom',
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('returns from a WeCom concrete form to mode selection', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const wecomBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信 / IM'),
    );
    await act(async () => {
      wecomBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const wsBtn = Array.from(host.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('企业微信智能机器人'),
    );
    await act(async () => {
      wsBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const backBtn = host.querySelector('[data-testid="form-cancel"]');
    await act(async () => {
      backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="manual-form"]')).toBeFalsy();
    expect(host.textContent).toContain('企业微信智能机器人');
    expect(host.textContent).toContain('企业微信自建应用（Callback）');

    await act(async () => {
      root.unmount();
    });
  });

  it('cancel button calls onCancel', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const cancelBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('取消') && !btn.textContent?.includes('飞书'),
    );

    await act(async () => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(defaultProps.onCancel).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('QR back button returns to platform selection', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const feishuBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('飞书'),
    );
    await act(async () => {
      feishuBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const backBtn = host.querySelector('[data-testid="qr-cancel"]');
    await act(async () => {
      backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('飞书');
    expect(host.querySelector('[data-testid="qr-setup"]')).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it('QR complete button calls onComplete', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const feishuBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('飞书'),
    );
    await act(async () => {
      feishuBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const completeBtn = host.querySelector('[data-testid="qr-complete"]');
    await act(async () => {
      completeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(defaultProps.onComplete).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('resets to platform selection when props change', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll('button');
    const telegramBtn = Array.from(buttons).find(
      (btn) => btn.textContent?.includes('Telegram'),
    );
    await act(async () => {
      telegramBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="manual-form"]')).toBeTruthy();

    await act(async () => {
      root.render(<PlatformBindingContent {...defaultProps} projectName="other-project" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('飞书');

    await act(async () => {
      root.unmount();
    });
  });
});

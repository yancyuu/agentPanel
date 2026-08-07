import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    ccSetup: {
      addPlatform: vi.fn(async () => ({
        message: 'saved',
        restart_required: true,
        restart_handled: false,
      })),
    },
  },
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

import { api } from '@renderer/api';
import PlatformManualForm from '@renderer/components/team/dialogs/PlatformManualForm';
import type { PlatformMeta } from '@renderer/components/team/dialogs/platformMeta';

const meta: PlatformMeta = {
  label: 'Test Platform',
  defaultOptions: { enabled: true, retries: 1 },
  fields: [
    { key: 'token', label: 'Token', required: true },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'retries', label: 'Retries', type: 'number' },
    { key: 'optional', label: 'Optional' },
  ],
};

async function renderForm(initialValues: Record<string, unknown> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onComplete = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <PlatformManualForm
        platformType="test"
        platformMeta={meta}
        projectName="project"
        workDir="/repo"
        agentType="claudecode"
        initialValues={initialValues}
        onComplete={onComplete}
        onCancel={vi.fn()}
      />
    );
  });
  return { host, root, onComplete };
}

async function clickSave(host: HTMLElement) {
  const button = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes('绑定平台')
  );
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('PlatformManualForm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves false and zero values that override defaults', async () => {
    const { host, root } = await renderForm({ token: 'secret', enabled: false, retries: 0 });
    await clickSave(host);

    expect(api.ccSetup.addPlatform).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({
        options: expect.objectContaining({ token: 'secret', enabled: false, retries: 0 }),
      })
    );
    await act(async () => root.unmount());
  });

  it('omits blank optional values', async () => {
    const { host, root } = await renderForm({ token: 'secret', optional: '' });
    await clickSave(host);

    const request = vi.mocked(api.ccSetup.addPlatform).mock.calls[0][1];
    expect(request.options).not.toHaveProperty('optional');
    await act(async () => root.unmount());
  });

  it('validates required values before saving', async () => {
    const { host, root } = await renderForm({ enabled: false, retries: 0 });
    await clickSave(host);

    expect(host.textContent).toContain('Token 为必填项');
    expect(api.ccSetup.addPlatform).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

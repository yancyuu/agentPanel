import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { providersApi } from '../../../../src/renderer/api/providers';
import { ProviderRuntimeSettingsDialog } from '../../../../src/renderer/components/runtime/ProviderRuntimeSettingsDialog';

import type { GlobalProvider } from '../../../../src/shared/types/providers';

vi.mock('../../../../src/renderer/api/providers', () => ({
  providersApi: {
    list: vi.fn(),
    fetchPresets: vi.fn(),
    update: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../../../../src/renderer/utils/openHermitEvents', () => ({
  OPEN_HERMIT_EVENTS: { providersChanged: 'providersChanged' },
  emitOpenHermitEvent: vi.fn(),
}));

const existingProvider: GlobalProvider = {
  name: 'custom',
  api_key: 'secret',
  base_url: 'https://old.example.test',
  model: 'old-model',
  thinking: 'enabled',
  agent_types: ['claudecode'],
  models: [{ model: 'old-model' }],
};

function renderDialog() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <ProviderRuntimeSettingsDialog
        open
        onOpenChange={vi.fn()}
        providers={[]}
        initialProviderId="anthropic"
        onSelectBackend={vi.fn()}
      />
    );
  });

  return { host, root };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ProviderRuntimeSettingsDialog', () => {
  it('sends cleared provider fields as undefined instead of preserving stale values', async () => {
    vi.mocked(providersApi.list).mockResolvedValue({ providers: [existingProvider] });
    vi.mocked(providersApi.fetchPresets).mockResolvedValue({ version: 1, providers: [] });
    vi.mocked(providersApi.update).mockResolvedValue({ message: 'ok' });

    const { host, root } = renderDialog();
    await flushPromises();

    const editButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('编辑')
    );
    if (!editButton) throw new Error('edit button not found');

    await act(async () => {
      editButton.click();
    });

    const baseUrlInput = document.body.querySelector(
      'input[placeholder="https://api.example.com/v1"]'
    ) as HTMLInputElement;
    const modelInput = document.body.querySelector(
      'input[placeholder="claude-sonnet-4 / gpt-4o / gemini-2.5-pro"]'
    ) as HTMLInputElement;
    expect(baseUrlInput.value).toBe('https://old.example.test');
    expect(modelInput.value).toBe('old-model');

    const setInputValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    };

    await act(async () => {
      setInputValue(baseUrlInput, '');
      setInputValue(modelInput, '');
    });

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('保存')
    );
    if (!saveButton) throw new Error('save button not found');

    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });

    expect(providersApi.update).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({ base_url: undefined, model: undefined })
    );

    await act(async () => {
      root.unmount();
    });
  });
});

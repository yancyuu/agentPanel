import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  api: {
    config: {
      browseFolders: vi.fn(async (dirPath?: string) => ({
        path: dirPath || '/tmp/agentcli-empty-ws',
        dirs: [],
      })),
    },
  },
}));

import { ProjectPathSelector } from '@renderer/components/team/dialogs/ProjectPathSelector';

function renderSelector(onChange: (path: string) => void): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ProjectPathSelector
        cwdMode="custom"
        onCwdModeChange={() => undefined}
        selectedProjectPath=""
        onSelectedProjectPathChange={() => undefined}
        customCwd="/tmp/agentcli-empty-ws"
        onCustomCwdChange={onChange}
        projects={[]}
        projectsLoading={false}
        projectsError={null}
      />
    );
  });
  return host;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FolderBrowser 空目录手动输入', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('空目录时可手动输入路径并确认选择', async () => {
    const onChange = vi.fn();
    const host = renderSelector(onChange);

    // 打开目录浏览（空目录）
    const browseButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '浏览'
    );
    await act(async () => {
      browseButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Dialog 经 portal 渲染到 document.body
    expect(document.body.textContent).toContain('此目录下没有子目录');

    // 对话框内可手动输入目标路径（创建智能体的关键路径）
    const pathInput = document.body.querySelector(
      'input[aria-label="手动输入目录路径"]'
    ) as HTMLInputElement;
    expect(pathInput).not.toBeNull();
    setInputValue(pathInput, '/tmp/agentcli-empty-ws');

    const confirmButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '选择'
    );
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('/tmp/agentcli-empty-ws');
  });
});

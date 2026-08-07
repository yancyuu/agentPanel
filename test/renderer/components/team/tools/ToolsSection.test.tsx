import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledMcpEntry, McpLibraryEntry } from '@shared/types/extensions';

interface StoreState {
  mcpInstalledServersByProjectPath: Record<string, InstalledMcpEntry[]>;
  mcpDiagnosticsByProjectPath: Record<string, Record<string, unknown>>;
  skillsProjectCatalogByProjectPath: Record<string, unknown[]>;
  skillsDetailsById: Record<string, unknown>;
  mcpFetchInstalled: ReturnType<typeof vi.fn>;
  runMcpDiagnostics: ReturnType<typeof vi.fn>;
  fetchSkillsCatalog: ReturnType<typeof vi.fn>;
  fetchSkillDetail: ReturnType<typeof vi.fn>;
  installCustomMcpServer: ReturnType<typeof vi.fn>;
  applySkillImport: ReturnType<typeof vi.fn>;
  previewSkillImport: ReturnType<typeof vi.fn>;
  uninstallMcpServer: ReturnType<typeof vi.fn>;
  deleteSkill: ReturnType<typeof vi.fn>;
}

const { storeState, libraryListMock, useStoreMock } = vi.hoisted(() => {
  const state = {} as StoreState;
  return {
    storeState: state,
    libraryListMock: vi.fn(),
    useStoreMock: Object.assign(
      (selector: (state: StoreState) => unknown) => selector(state),
      { getState: () => state }
    ),
  };
});

vi.mock('@renderer/store', () => ({
  useStore: useStoreMock,
}));

vi.mock('@renderer/api', () => ({
  api: {
    mcpRegistry: {
      libraryList: libraryListMock,
    },
    skills: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) =>
    React.createElement(
      'button',
      {
        type: 'button',
        disabled,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props),
}));

vi.mock('@renderer/components/team/tools/AddMcpInline', () => ({
  AddMcpInline: () => React.createElement('div', null, 'add-mcp-inline'),
}));

vi.mock('@renderer/components/team/tools/AddSkillInline', () => ({
  AddSkillInline: () => React.createElement('div', null, 'add-skill-inline'),
}));

vi.mock('@renderer/components/team/tools/McpChip', () => ({
  McpChip: ({ entry }: { entry: { name: string } }) => React.createElement('span', null, entry.name),
}));

vi.mock('@renderer/components/team/tools/SkillChip', () => ({
  SkillChip: ({ skill }: { skill: { name: string } }) => React.createElement('span', null, skill.name),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Plus: Icon,
    RefreshCw: Icon,
    Server: Icon,
    Trash2: Icon,
    Wrench: Icon,
    X: Icon,
  };
});

import { ToolsSection } from '@renderer/components/team/tools/ToolsSection';

const templateEntry: McpLibraryEntry = {
  id: 'template-context7',
  name: 'context7-template',
  description: 'Context7 template',
  installSpec: {
    type: 'http',
    url: 'https://mcp.example.test/context7',
    transportType: 'streamable-http',
  },
  envValues: {
    CONTEXT7_MODE: 'docs',
  },
  headers: [
    {
      key: 'Authorization',
      value: 'Bearer token-from-template',
      secret: true,
    },
  ],
  createdAt: 1,
  updatedAt: 2,
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setNativeValue(element: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  const root = host.ownerDocument.body;
  return Array.from(root.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement | undefined;
}

function findInputByValue(host: HTMLElement, value: string): HTMLInputElement {
  const root = host.ownerDocument.body;
  const input = Array.from(root.querySelectorAll('input')).find((element) => element.value === value);
  if (!input) throw new Error(`Input with value ${value} not found in ${root.innerHTML}`);
  return input;
}

describe('ToolsSection MCP library enable flow', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    libraryListMock.mockResolvedValue([templateEntry]);
    storeState.mcpInstalledServersByProjectPath = {};
    storeState.mcpDiagnosticsByProjectPath = {};
    storeState.skillsProjectCatalogByProjectPath = {};
    storeState.skillsDetailsById = {};
    storeState.mcpFetchInstalled = vi.fn().mockResolvedValue(undefined);
    storeState.runMcpDiagnostics = vi.fn().mockResolvedValue(undefined);
    storeState.fetchSkillsCatalog = vi.fn().mockResolvedValue(undefined);
    storeState.fetchSkillDetail = vi.fn().mockResolvedValue(undefined);
    storeState.installCustomMcpServer = vi.fn().mockResolvedValue(undefined);
    storeState.applySkillImport = vi.fn().mockResolvedValue(undefined);
    storeState.previewSkillImport = vi.fn().mockResolvedValue({ planId: 'plan-1' });
    storeState.uninstallMcpServer = vi.fn().mockResolvedValue(undefined);
    storeState.deleteSkill = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('enables a saved MCP template for the team project with its spec, env, headers, and harness', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ToolsSection, {
          teamName: 'docs-team',
          projectPath: '/tmp/docs-project',
          harnessType: 'claudecode',
        })
      );
      await flushPromises();
    });

    const addFromTemplateButton = findButton(host, '从模板添加');
    if (!addFromTemplateButton) {
      throw new Error(host.innerHTML);
    }

    await act(async () => {
      addFromTemplateButton.click();
      await flushPromises();
    });

    await act(async () => {
      setNativeValue(findInputByValue(document.body, 'context7-template'), 'context7-project');
      setNativeValue(findInputByValue(document.body, 'docs'), 'project-docs');
      setNativeValue(findInputByValue(document.body, 'Bearer token-from-template'), 'Bearer project-token');
      await flushPromises();
    });

    const submitButton = findButton(document.body, '添加到当前项目');
    if (!submitButton) {
      throw new Error(document.body.innerHTML);
    }

    await act(async () => {
      submitButton.click();
      await flushPromises();
    });

    expect(storeState.installCustomMcpServer).toHaveBeenCalledWith({
      serverName: 'context7-project',
      scope: 'project',
      projectPath: '/tmp/docs-project',
      installSpec: templateEntry.installSpec,
      envValues: {
        CONTEXT7_MODE: 'project-docs',
      },
      headers: [
        {
          key: 'Authorization',
          value: 'Bearer project-token',
          secret: true,
        },
      ],
      harnessType: 'claudecode',
    });
    expect(storeState.mcpFetchInstalled).toHaveBeenCalledWith('/tmp/docs-project');
    expect(storeState.runMcpDiagnostics).toHaveBeenCalledWith('/tmp/docs-project');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps a template available when an installed instance uses a different server name', async () => {
    storeState.mcpInstalledServersByProjectPath = {
      '/tmp/docs-project': [
        {
          name: 'context7-dev',
          scope: 'project',
          transport: 'http',
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ToolsSection, {
          teamName: 'docs-team',
          projectPath: '/tmp/docs-project',
          harnessType: 'claudecode',
        })
      );
      await flushPromises();
    });

    expect(host.textContent).toContain('context7-template');
    const addFromTemplateButton = findButton(host, '从模板添加');
    if (!addFromTemplateButton) {
      throw new Error(host.innerHTML);
    }
    expect(addFromTemplateButton).toBeDefined();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

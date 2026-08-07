import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedCapabilityPack } from '@shared/types/extensions';

interface StoreState {
  capabilityPacks: LoadedCapabilityPack[];
  capabilityPackList: { warnings: string[] } | null;
  capabilityPacksLoading: boolean;
  capabilityPacksError: string | null;
  capabilityPacksMutationLoading: boolean;
  capabilityPacksMutationError: string | null;
  fetchCapabilityPacks: ReturnType<typeof vi.fn>;
  exportCapabilityPack: ReturnType<typeof vi.fn>;
  addExtensionToast: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) =>
    React.createElement('button', { type: 'button', disabled, onClick }, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren<{ value: string }>) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) => React.createElement('span', null, placeholder),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    Download: Icon,
    Filter: Icon,
    Loader2: Icon,
    Package: Icon,
    RefreshCw: Icon,
  };
});

import { CapabilityPacksPanel } from '@renderer/components/extensions/capability-packs/CapabilityPacksPanel';

function buildPack(overrides: Partial<LoadedCapabilityPack>): LoadedCapabilityPack {
  return {
    source: 'local',
    enabled: true,
    warnings: [],
    packDir: '/tmp/pack',
    ...overrides,
    manifest: {
      schemaVersion: 1,
      id: overrides.manifest?.id ?? 'pack',
      name: overrides.manifest?.name ?? 'Pack',
      namespace: overrides.manifest?.namespace ?? 'local',
      version: overrides.manifest?.version ?? '1.0.0',
      tags: overrides.manifest?.tags,
      teamName: overrides.manifest?.teamName,
      capabilities: overrides.manifest?.capabilities ?? {},
    },
  };
}

function renderPanel(): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<CapabilityPacksPanel />);
  });
  return { host, root };
}

describe('CapabilityPacksPanel', () => {
  beforeEach(() => {
    storeState.capabilityPacks = [
      buildPack({
        manifest: {
          schemaVersion: 1,
          id: 'local-team-a',
          name: 'Team A Local Capabilities',
          namespace: 'local',
          version: '1.0.0',
          tags: ['local'],
          teamName: 'team-a',
          capabilities: { skills: [{ id: 'review', name: 'Review', path: 'skills/review' }] },
        },
      }),
      buildPack({
        manifest: {
          schemaVersion: 1,
          id: 'local-team-b',
          name: 'Team B Local Capabilities',
          namespace: 'local',
          version: '1.0.0',
          tags: ['local'],
          teamName: 'team-b',
          capabilities: {
            cron: [
              {
                id: 'daily-summary',
                name: 'Daily summary',
                cronExpression: '17 9 * * 1-5',
                prompt: '/hermit:summary',
                enabled: true,
              },
            ],
          },
        },
      }),
      buildPack({
        source: 'builtin',
        manifest: {
          schemaVersion: 1,
          id: 'hermit-team-ops',
          name: 'AgentPanel Team Ops',
          namespace: 'hermit',
          version: '1.0.0',
          tags: ['hermit'],
          capabilities: {
            commands: [
              {
                id: 'doctor',
                alias: 'doctor',
                title: 'Doctor',
                scope: ['admin-loop'],
                surfaces: ['slash'],
                safety: 'read-only',
                prompt: 'commands/doctor.md',
              },
            ],
          },
        },
      }),
    ];
    storeState.capabilityPackList = { warnings: [] };
    storeState.capabilityPacksLoading = false;
    storeState.capabilityPacksError = null;
    storeState.capabilityPacksMutationLoading = false;
    storeState.capabilityPacksMutationError = null;
    storeState.fetchCapabilityPacks = vi.fn();
    storeState.exportCapabilityPack = vi.fn(async () => ({ pack: null, warnings: [] }));
    storeState.addExtensionToast = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders plugin-style filters and local shows every team local pack', () => {
    const { host, root } = renderPanel();

    expect(host.textContent).toContain('项目能力包');
    expect(host.textContent).toContain('.claude/skills');
    expect(host.textContent).not.toContain('团队能力包');
    expect(host.textContent).not.toContain('后续插件包按团队启用');
    expect(host.textContent).toContain('按适用场景浏览');
    expect(host.textContent).toContain('0 个筛选条件已启用');
    expect(host.textContent).toContain('按分类、能力或安装状态缩小目录范围。');
    expect(host.textContent).toContain('3 个能力包');
    expect(host.textContent).toContain('2 个分类');
    expect(host.textContent).toContain('3 项能力');

    const localFilter = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('local')
    );
    expect(localFilter).toBeTruthy();

    act(() => {
      localFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('1 个筛选条件已启用');
    expect(host.textContent).toContain('Team A Local Capabilities');
    expect(host.textContent).toContain('Team B Local Capabilities');
    expect(host.textContent).not.toContain('AgentPanel Team Ops');

    act(() => {
      root.unmount();
    });
  });
});

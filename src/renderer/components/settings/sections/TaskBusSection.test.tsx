import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskBusSection } from './TaskBusSection';

interface TelemetryProjectFixture {
  cwd: string;
  displayName: string;
  teamSlug?: string;
  bindProject?: string;
  deletedAt?: string;
  sessions: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

function telemetryProjects(projectCount: number): TelemetryProjectFixture[] {
  return Array.from({ length: projectCount }, (_, index) => ({
    cwd: `/tmp/telemetry-entry-${index + 1}`,
    displayName: `telemetry-entry-${index + 1}`,
    sessions: 1,
    messages: projectCount - index,
    tokensIn: 10,
    tokensOut: 20,
    tokensTotal: 30,
  }));
}

function telemetryStatus(projects: TelemetryProjectFixture[]) {
  return {
    connected: false,
    lastScan: '2026-06-15T00:00:00.000Z',
    sessions: projects.length,
    messages: projects.length * 10,
    tokensIn: 100,
    tokensOut: 200,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 300,
    activeDays: 1,
    hourly: new Array(24).fill(0),
    projects,
    workSecondsByDay: {},
    localUsers: [],
    teamCapabilitySnapshots: [],
    unresolvedUsage: { sessions: 0, messages: 0, tokensTotal: 0 },
  };
}

function mockFetch(
  projectCountOrProjects: number | TelemetryProjectFixture[],
  telemetryOverrides: Record<string, unknown> = {}
): ReturnType<typeof vi.fn> {
  const projects = Array.isArray(projectCountOrProjects)
    ? projectCountOrProjects
    : telemetryProjects(projectCountOrProjects);
  const status = { ...telemetryStatus(projects), ...telemetryOverrides };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/telemetry/status')) {
      return Promise.resolve(new Response(JSON.stringify(status), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderTaskBusSection() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(React.createElement(TaskBusSection));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { host, root };
}

describe('TaskBusSection telemetry settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders local usage monitoring without sync controls or old IM attribution panels', async () => {
    mockFetch(11, {
      localUsers: [
        {
          key: 'local:user',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: 'Local User',
            confidence: 'session-key-only',
          },
          projectName: 'local-project',
          sessions: 1,
          messages: 7,
          tokensTotal: 1200,
        },
      ],
    });

    const { host, root } = await renderTaskBusSection();

    expect(host.textContent).toContain('Usage 监测');
    expect(host.textContent).toContain('本地生成用量（source=local）');
    expect(host.textContent).not.toContain('Usage 同步');
    expect(host.textContent).not.toContain('后台持续同步');
    expect(host.textContent).not.toContain('立即扫描一次');
    expect(host.textContent).not.toContain('后台持续同步未开启，可手动同步一次');
    expect(host.textContent).not.toContain('IM 接入归因用量（source=feishu/wechat/...）');
    expect(host.textContent).toContain('local-project');
    expect(host.textContent).not.toContain('项目吞吐');
    expect(host.textContent).not.toContain('telemetry-entry-10');

    await act(async () => {
      root.unmount();
    });
  });

  it('shows unresolved local sessions without rendering IM attribution rows', async () => {
    mockFetch(1, {
      unresolvedUsage: { sessions: 2, messages: 8, tokensTotal: 900 },
    });

    const { host, root } = await renderTaskBusSection();

    expect(host.textContent).not.toContain('IM 接入归因用量（source=feishu/wechat/...）');
    expect(host.textContent).toContain('未映射会话：2 sessions');
    expect(host.textContent).toContain('900 tokens');

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps digital employee capability assets folded until employee and kind are expanded', async () => {
    mockFetch(1, {
      capabilitySummary: { teams: 1, commands: 1, skills: 4, workflows: 1, cron: 1, mcpServers: 1 },
      teamCapabilitySnapshots: [
        {
          teamName: 'agent-alpha',
          teamDisplayName: 'Agent Alpha',
          projectDir: '/tmp/agent-alpha',
          projectName: 'agent-alpha',
          sourcePackIds: ['pack-alpha'],
          counts: { commands: 1, skills: 4, workflows: 1, cron: 1, mcpServers: 1 },
          fingerprint: 'fp-1',
          reportedAt: '2026-06-15T00:00:00.000Z',
          assets: [
            {
              kind: 'skill',
              id: 'skill-1',
              name: 'Skill One',
              description: 'Long skill description',
              packId: 'pack-alpha',
            },
            { kind: 'skill', id: 'skill-2', name: 'Skill Two', packId: 'pack-alpha' },
            { kind: 'skill', id: 'skill-3', name: 'Skill Three', packId: 'pack-alpha' },
            { kind: 'skill', id: 'skill-4', name: 'Skill Four', packId: 'pack-alpha' },
            {
              kind: 'workflow',
              id: 'wf-1',
              name: 'Workflow One',
              description: 'Workflow detail',
              packId: 'pack-alpha',
            },
            {
              kind: 'cron',
              id: 'cron-1',
              name: 'Cron One',
              description: 'Cron detail',
              enabled: true,
              packId: 'pack-alpha',
            },
            {
              kind: 'mcp',
              id: 'mcp-1',
              name: 'MCP One',
              transport: 'stdio',
              scope: 'project',
              packId: 'pack-alpha',
            },
            { kind: 'command', id: 'cmd-1', name: 'Command One', packId: 'pack-alpha' },
          ],
        },
      ],
    });

    const { host, root } = await renderTaskBusSection();

    expect(host.textContent).toContain('数字员工能力资产');
    expect(host.textContent).toContain('Agent Alpha');
    expect(host.textContent).toContain('Skills 4');
    expect(host.textContent).toContain('Workflows 1');
    expect(host.textContent).toContain('Cron 1');
    expect(host.textContent).toContain('MCP 1');
    expect(host.textContent).not.toContain('Skill One');
    expect(host.textContent).not.toContain('Long skill description');
    expect(host.textContent).not.toContain('Workflow detail');

    const agentButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Agent Alpha')
    );
    expect(agentButton).toBeTruthy();

    await act(async () => {
      agentButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('收起能力明细');
    expect(host.textContent).toContain('Skills');
    expect(host.textContent).not.toContain('Skill One');

    const skillsButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Skills') && button.textContent?.includes('展开')
    );
    expect(skillsButton).toBeTruthy();

    await act(async () => {
      skillsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('Skill One');
    expect(host.textContent).toContain('Skill Four');
    expect(host.textContent).toContain('Long skill description');
    expect(host.textContent).not.toContain('Workflow detail');

    await act(async () => {
      root.unmount();
    });
  });

  it('aggregates local usage rows by project path', async () => {
    mockFetch(0, {
      localUsers: [
        {
          key: 'hermit:one',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: 'hermit',
            confidence: 'session-key-only',
          },
          projectName: 'hermit',
          workDir: '/Users/yancyyu/code/hermit',
          sessions: 1,
          messages: 3100,
          tokensTotal: 208_400_000,
        },
        {
          key: 'hermit:two',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: 'hermit',
            confidence: 'session-key-only',
          },
          projectName: 'hermit',
          workDir: '/Users/yancyyu/code/hermit',
          sessions: 2,
          messages: 5900,
          tokensTotal: 410_900_000,
        },
        {
          key: 'dot-hermit',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: '.hermit',
            confidence: 'session-key-only',
          },
          projectName: '.hermit',
          workDir: '/Users/yancyyu/.hermit',
          sessions: 1,
          messages: 5,
          tokensTotal: 93_600,
        },
        {
          key: 'dot-hermit:auth-name',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: 'auth',
            confidence: 'session-key-only',
          },
          projectName: 'auth',
          workDir: '/Users/yancyyu/.hermit/auth',
          sessions: 1,
          messages: 34,
          tokensTotal: 728_600,
        },
        {
          key: 'dot-hermit:auth-name-again',
          kind: 'local',
          identity: {
            platform: 'local',
            type: 'person',
            displayName: '.hermit auth',
            confidence: 'session-key-only',
          },
          projectName: '.hermit auth',
          workDir: '/Users/yancyyu/.hermit/auth/',
          sessions: 1,
          messages: 7,
          tokensTotal: 0,
        },
      ],
    });

    const { host, root } = await renderTaskBusSection();

    expect(host.textContent).toContain('9.0K msg · 619.3M tokens');
    expect(host.textContent).toContain('5 msg · 93.6K tokens');
    expect(host.textContent).toContain('41 msg · 728.6K tokens');
    expect(host.textContent).not.toContain('3.1K msg · 208.4M tokens');
    expect(host.textContent).not.toContain('5.9K msg · 410.9M tokens');
    expect(host.textContent).not.toContain('34 msg · 728.6K tokens');
    expect(host.textContent).not.toContain('7 msg · 0 tokens');

    await act(async () => {
      root.unmount();
    });
  });

  it('renders usage monitoring with task-bus controls but without enterprise IM texts', async () => {
    const fetchMock = mockFetch(1);

    const { host, root } = await renderTaskBusSection();

    expect(host.textContent).toContain('Usage 监测');
    // usage 控制条（采集启停/立即上报/团队协作开关）已接入 task-bus settings
    expect(host.querySelector('[data-testid="usage-control-bar"]')).not.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/settings/task-bus');
    expect(host.textContent).not.toContain('IM 协作');
    expect(host.textContent).not.toContain('分布式团队协作');
    expect(host.textContent).not.toContain('企业版开放');

    await act(async () => {
      root.unmount();
    });
  });
});

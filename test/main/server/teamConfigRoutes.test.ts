/* eslint-disable @typescript-eslint/require-await -- async test doubles implement Promise-returning route dependencies. */

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamConfigRoutes } from '../../../src/main/routes/teamConfigRoutes';
import type { TeamManifest } from '../../../src/main/services/team-management/TeamWorkspaceService';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerTeamConfigRoutes>[1];

function manifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return {
    schemaVersion: 2,
    slug: 'team-a',
    displayName: '团队 A',
    bindProject: 'project-a',
    harness: 'claudecode',
    workDir: '/manifest/work',
    rootPath: '/hermit/team-a',
    createdAt: '2026-01-01',
    language: 'en',
    permissionMode: 'default',
    managedSources: '*',
    platformAllowFrom: { feishu: 'old-user' },
    ...overrides,
  };
}

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  let toml = `[[projects]]\nname = "project-a"\nreset_on_idle_mins = 15\n\n[[projects.platforms]]\ntype = "lark"\n[projects.platforms.options]\ndomain = "feishu"\n`;
  const teamProvisioning = {
    updateTeam: vi.fn(async () => manifest()),
    createTeam: vi.fn(async () => ({ slug: 'team-a', manifest: manifest() })),
    readTeamManifest: vi.fn(async () => manifest()),
  };
  const bridgeClient = {
    getProject: vi.fn(async () => ({
      name: 'project-a',
      agent_type: 'claudecode',
      agent_mode: 'acceptEdits',
      work_dir: '/bridge/work',
      platforms: [],
      settings: {
        language: 'zh-CN',
        admin_from: 'owner',
        disabled_commands: ['rm'],
        platform_allow_from: { lark: 'user-1' },
      },
    })),
    updateProject: vi.fn(async () => ({ message: 'updated', restart_required: true })),
    reload: vi.fn(async () => undefined),
    getProviderRefs: vi.fn(async () => ['provider-a']),
    setProviderRefs: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => [{ name: 'provider-a' }]),
  };
  const writeConfigTomlRaw = vi.fn((content: string) => {
    toml = content;
  });
  const dependencies = {
    teamProvisioning,
    bridgeClient,
    resolveProjectName: vi.fn(async () => 'project-a'),
    readConfigTomlRaw: () => ({ path: '/tmp/config.toml', content: toml }),
    writeConfigTomlRaw,
    reply500: (error: unknown) => ({ ok: false, error: String(error) }),
    assertCliAvailable: vi.fn(async () => undefined),
  } as unknown as Dependencies;
  registerTeamConfigRoutes(app, dependencies);
  return {
    app,
    dependencies,
    teamProvisioning,
    bridgeClient,
    writeConfigTomlRaw,
    getToml: () => toml,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('team config routes', () => {
  it('overlays bridge settings on local metadata and reads provider/TOML options', async () => {
    const harness = createHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/teams/team-a/config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        name: 'team-a',
        projectPath: '/bridge/work',
        language: 'zh-CN',
        managedSources: 'owner',
        disabledCommands: ['rm'],
        permissionMode: 'acceptEdits',
        platformAllowFrom: { lark: 'user-1' },
        providerRefs: ['provider-a'],
      })
    );
  });

  it('preserves invalid and unavailable agent-type errors', async () => {
    const harness = createHarness();
    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/config',
      payload: { agentType: 'unsupported-runtime' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('不是支持的运行时类型');

    (harness.dependencies.assertCliAvailable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('cli missing')
    );
    const unavailable = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/config',
      payload: { agentType: 'codex' },
    });
    expect(unavailable.statusCode).toBe(400);
  });

  it('syncs local metadata, cc-connect fields, provider refs, and reloads when required', async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/config',
      payload: {
        name: '新名字',
        language: 'zh-CN',
        permissionMode: 'acceptEdits',
        disabledCommands: [' rm ', ''],
        platformAllowFrom: { feishu: 'old', lark: 'new-user' },
        providerRefs: [' provider-a ', ''],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.teamProvisioning.updateTeam).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        displayName: '新名字',
        disabledCommands: ['rm'],
        platformAllowFrom: { lark: 'new-user' },
      })
    );
    expect(harness.bridgeClient.updateProject).toHaveBeenCalledWith(
      'project-a',
      expect.objectContaining({
        language: 'zh-CN',
        mode: 'acceptEdits',
        disabled_commands: ['rm'],
        platform_allow_from: { lark: 'new-user' },
      })
    );
    expect(harness.bridgeClient.setProviderRefs).toHaveBeenCalledWith('project-a', ['provider-a']);
    expect(harness.bridgeClient.reload).toHaveBeenCalled();
  });

  it('tolerates missing cc projects and creates local metadata when needed', async () => {
    const harness = createHarness();
    harness.teamProvisioning.updateTeam
      .mockRejectedValueOnce(new Error('local missing'))
      .mockResolvedValueOnce(manifest());
    harness.bridgeClient.updateProject.mockRejectedValueOnce(
      new Error('project not found: project-a')
    );
    harness.bridgeClient.setProviderRefs.mockRejectedValueOnce(
      new Error('project not found: project-a')
    );

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/config',
      payload: { name: '创建元数据', providerRefs: ['provider-a'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ccSyncError).toBeNull();
    expect(harness.teamProvisioning.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: '创建元数据', createCcProject: false })
    );
  });

  it('updates reset/platform TOML options and keeps PUT behavior aligned with PATCH', async () => {
    const harness = createHarness();
    const patch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/teams/team-a/config',
      payload: {
        resetOnIdleMins: 30,
        platformOptions: { lark: { domain: 'larksuite', encrypt: 'true' } },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(harness.getToml()).toContain('reset_on_idle_mins = 30');
    expect(harness.getToml()).toContain('domain = "larksuite"');
    expect(harness.getToml()).toContain('encrypt = true');

    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/teams/team-a/config',
      payload: { color: 'green' },
    });
    expect(put.statusCode).toBe(200);
    expect(harness.teamProvisioning.updateTeam).toHaveBeenLastCalledWith('team-a', {
      color: 'green',
    });
  });
});

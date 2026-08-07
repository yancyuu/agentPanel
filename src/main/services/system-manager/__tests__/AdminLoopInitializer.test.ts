import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_INIT_MESSAGE_ID,
  type AdminLoopInitDeps,
  AGENTPANEL_OPS_GUIDE_MARKER,
  buildAdminInitMessage,
  CURRENT_AGENTPANEL_OPERATIONS_GUIDE,
  ensureAdminLoopInitialized,
  htmlToPlainText,
} from '../AdminLoopInitializer';

import type { SystemManagerConfig, SystemManagerConfigPatch } from '@shared/types/systemManager';

interface Recorder {
  getConfig: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  hasExistingBootstrap?: ReturnType<typeof vi.fn>;
  writeBootstrapArtifact?: ReturnType<typeof vi.fn>;
  fetchGuide: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides?: Partial<Recorder>): Recorder & AdminLoopInitDeps {
  const r: Recorder = {
    getConfig: vi.fn(async () => ({ schemaVersion: 1, selectedWorkDir: '/x', updatedAt: 't' })),
    updateConfig: vi.fn(
      async (patch: SystemManagerConfigPatch) =>
        ({
          schemaVersion: 1,
          selectedWorkDir: '/x',
          updatedAt: 't',
          ...patch,
        }) as SystemManagerConfig
    ),
    writeBootstrapArtifact: vi.fn(async () => undefined),
    fetchGuide: vi.fn(async () => ({ statusCode: 200, body: '<p>hello manual</p>' })),
    dispatch: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
  return r as Recorder & AdminLoopInitDeps;
}

describe('htmlToPlainText', () => {
  it('strips script/style and tags, decodes entities, collapses whitespace', () => {
    const html =
      '<style>.x{}</style><script>alert(1)</script><h1>Title</h1><p>a&nbsp;&amp;b</p><!--c-->';
    expect(htmlToPlainText(html)).toBe('Title\na &b');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(htmlToPlainText('   \n  ')).toBe('');
  });
});

describe('buildAdminInitMessage', () => {
  it('wraps the guide text with the bootstrap instructions', () => {
    const msg = buildAdminInitMessage('MANUAL_BODY');
    expect(msg).toContain('诊断初始化');
    expect(msg).toContain('MANUAL_BODY');
    expect(msg).toContain('内置 AgentPanel 任务总线');
    expect(msg).not.toContain('/workers');
  });
});

describe('CURRENT_AGENTPANEL_OPERATIONS_GUIDE', () => {
  it('uses the current AgentPanel product model without legacy installation instructions', () => {
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).toContain(AGENTPANEL_OPS_GUIDE_MARKER);
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).toContain('创建任务');
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).toContain('调教');
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).toContain('$HERMIT_HOME/bin/agentpanel');
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).toContain('--team {team-id}');
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).not.toContain('npm install -g @yancyyu/openhermit');
    expect(CURRENT_AGENTPANEL_OPERATIONS_GUIDE).not.toContain('openhermit # 启动');
  });
});

describe('ensureAdminLoopInitialized', () => {
  afterEach(() => vi.clearAllMocks());

  it('is idempotent: skips fetch + dispatch + updateConfig when the artifact exists and the marker is already set', async () => {
    const deps = makeDeps({
      getConfig: vi.fn(async () => ({
        schemaVersion: 1,
        selectedWorkDir: '/x',
        updatedAt: 't',
        adminInitialized: true,
      })),
      hasExistingBootstrap: vi.fn(async () => true),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.hasExistingBootstrap).toHaveBeenCalledTimes(1);
    expect(deps.fetchGuide).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.writeBootstrapArtifact).not.toHaveBeenCalled();
    expect(deps.updateConfig).not.toHaveBeenCalled();
  });

  it('treats an existing CLAUDE.md bootstrap as initialized without fetching the guide', async () => {
    const deps = makeDeps({
      hasExistingBootstrap: vi.fn(async () => true),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.hasExistingBootstrap).toHaveBeenCalledTimes(1);
    expect(deps.fetchGuide).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.updateConfig).toHaveBeenCalledWith({ adminInitialized: true });
  });

  it('re-bootstraps when adminInitialized is true but the CLAUDE.md artifact is missing', async () => {
    // Regression for "每次进来都会初始化 / 不会检测我到底有没有初始化": the persisted
    // boolean alone must NOT short-circuit — a missing artifact means not initialized.
    const deps = makeDeps({
      getConfig: vi.fn(async () => ({
        schemaVersion: 1,
        selectedWorkDir: '/x',
        updatedAt: 't',
        adminInitialized: true,
      })),
      hasExistingBootstrap: vi.fn(async () => false),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.hasExistingBootstrap).toHaveBeenCalledTimes(1);
    expect(deps.fetchGuide).toHaveBeenCalledTimes(1);
    expect(deps.writeBootstrapArtifact).toHaveBeenCalledWith('hello manual');
    expect(deps.dispatch).toHaveBeenCalledWith({
      text: buildAdminInitMessage('hello manual'),
      messageId: ADMIN_INIT_MESSAGE_ID,
    });
    expect(deps.updateConfig).toHaveBeenCalledWith({ adminInitialized: true });
  });

  it('does NOT set the marker when the guide fetch rejects', async () => {
    const deps = makeDeps({
      fetchGuide: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.updateConfig).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  it('does NOT set the marker on non-2xx status', async () => {
    const deps = makeDeps({
      fetchGuide: vi.fn(async () => ({ statusCode: 503, body: 'unavailable' })),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.updateConfig).not.toHaveBeenCalled();
  });

  it('does NOT set the marker when the body is empty', async () => {
    const deps = makeDeps({
      fetchGuide: vi.fn(async () => ({ statusCode: 200, body: '<script>x</script>' })),
    });

    await ensureAdminLoopInitialized(deps);

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.updateConfig).not.toHaveBeenCalled();
  });

  it('on success writes the CLAUDE.md artifact, dispatches the wrapped guide, then sets the marker', async () => {
    const deps = makeDeps();

    await ensureAdminLoopInitialized(deps);

    expect(deps.fetchGuide).toHaveBeenCalledTimes(1);
    expect(deps.writeBootstrapArtifact).toHaveBeenCalledWith('hello manual');
    expect(deps.dispatch).toHaveBeenCalledWith({
      text: buildAdminInitMessage('hello manual'),
      messageId: ADMIN_INIT_MESSAGE_ID,
    });
    expect(deps.updateConfig).toHaveBeenCalledWith({ adminInitialized: true });
    // The durable marker is written BEFORE the dispatch, so a failed agent
    // session still leaves the gate satisfied.
    expect(deps.writeBootstrapArtifact!.mock.invocationCallOrder[0]).toBeLessThan(
      deps.dispatch.mock.invocationCallOrder[0]
    );
  });
});

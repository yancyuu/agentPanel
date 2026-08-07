import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerExtensionSkillRoutes } from '../../../src/main/routes/extensionSkillRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
type Dependencies = Parameters<typeof registerExtensionSkillRoutes>[1];

function createHarness() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const result = () => Promise.resolve({ success: true, data: { ok: true } });
  const handlers = {
    skillsList: vi.fn(result),
    skillsGetDetail: vi.fn(result),
    skillsUpsert: vi.fn(result),
    skillsDelete: vi.fn(result),
    skillsPreviewUpsert: vi.fn(result),
    skillsApplyUpsert: vi.fn(result),
    skillsPreviewImport: vi.fn(result),
    skillsApplyImport: vi.fn(result),
    skillsStartWatching: vi.fn(result),
    skillsStopWatching: vi.fn(result),
  } as unknown as Dependencies['handlers'];
  registerExtensionSkillRoutes(app, { handlers });
  return { app, handlers };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('extension skill routes', () => {
  it('forwards list/detail project context and watch lifecycle inputs', async () => {
    const { app, handlers } = createHarness();

    await app.inject({
      method: 'GET',
      url: '/api/extensions/skills?projectPath=%2Ftmp%2Fproject',
    });
    await app.inject({
      method: 'GET',
      url: '/api/extensions/skills/skill-a?projectPath=%2Ftmp%2Fproject',
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/skills/watching/start?projectPath=%2Ftmp%2Fproject',
    });
    await app.inject({
      method: 'POST',
      url: '/api/extensions/skills/watching/stop',
      payload: { watchId: 'watch-a' },
    });

    expect(handlers.skillsList).toHaveBeenCalledWith('/tmp/project');
    expect(handlers.skillsGetDetail).toHaveBeenCalledWith('skill-a', '/tmp/project');
    expect(handlers.skillsStartWatching).toHaveBeenCalledWith('/tmp/project');
    expect(handlers.skillsStopWatching).toHaveBeenCalledWith('watch-a');
  });

  it('keeps mutation, preview, apply, and import payloads unchanged', async () => {
    const { app, handlers } = createHarness();
    const payload = { skillId: 'skill-a', content: '# Skill' };
    const cases = [
      ['upsert', handlers.skillsUpsert],
      ['delete', handlers.skillsDelete],
      ['preview-upsert', handlers.skillsPreviewUpsert],
      ['apply-upsert', handlers.skillsApplyUpsert],
      ['preview-import', handlers.skillsPreviewImport],
      ['apply-import', handlers.skillsApplyImport],
    ] as const;

    for (const [path, handler] of cases) {
      await app.inject({ method: 'POST', url: `/api/extensions/skills/${path}`, payload });
      expect(handler).toHaveBeenCalledWith(payload);
    }
  });
});

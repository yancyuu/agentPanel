import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFeishuAssistantRoutes } from '../../../src/main/routes/feishuAssistantRoutes';

const apps: ReturnType<typeof Fastify>[] = [];

function createHarness(module: {
  createFeishuAssistant?: ReturnType<typeof vi.fn>;
  listFeishuAssistants?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerFeishuAssistantRoutes(app, {
    loadModule: async () => ({
      createFeishuAssistant:
        module.createFeishuAssistant ??
        vi.fn(() => ({ ok: true, teamSlug: 'xiao-helper', message: 'ok' })),
      listFeishuAssistants:
        module.listFeishuAssistants ??
        vi.fn(() => ({
          ok: true,
          projects: [{ name: '小助手', teamSlug: 'xiao-helper', status: 'running' }],
          message: '',
        })),
    }),
  });
  return { app };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('feishu assistant routes（复用 bin/lib 实现）', () => {
  it('GET 返回 bin/lib 的助理列表', async () => {
    const listFeishuAssistants = vi.fn(() => ({
      ok: true,
      projects: [{ name: '小助手', teamSlug: 'xiao-helper', status: 'running' }],
      message: '',
    }));
    const { app } = createHarness({ listFeishuAssistants });

    const response = await app.inject({ method: 'GET', url: '/api/feishu-assistants' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      projects: [{ name: '小助手', teamSlug: 'xiao-helper', status: 'running' }],
      message: '',
    });
    expect(listFeishuAssistants).toHaveBeenCalledTimes(1);
  });

  it('POST 透传创建参数并返回结果；缺少名称时 400', async () => {
    const createFeishuAssistant = vi.fn(() => ({
      ok: true,
      alreadyExists: false,
      teamSlug: 'xiao-helper',
      message: '飞书个人助理已创建',
    }));
    const { app } = createHarness({ createFeishuAssistant });

    const created = await app.inject({
      method: 'POST',
      url: '/api/feishu-assistants',
      payload: { name: ' 小助手 ', description: '答疑' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: true, teamSlug: 'xiao-helper' });
    expect(createFeishuAssistant).toHaveBeenCalledWith({
      name: '小助手',
      description: '答疑',
      aiKey: undefined,
      appId: undefined,
      appSecret: undefined,
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/feishu-assistants',
      payload: { name: '  ' },
    });
    expect(missing.statusCode).toBe(400);
    expect(createFeishuAssistant).toHaveBeenCalledTimes(1);
  });

  it('bin/lib 返回失败时透传 400 与错误文案', async () => {
    const createFeishuAssistant = vi.fn(() => ({ ok: false, message: '创建失败：名称已存在' }));
    const { app } = createHarness({ createFeishuAssistant });

    const response = await app.inject({
      method: 'POST',
      url: '/api/feishu-assistants',
      payload: { name: '小助手' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('名称已存在');
  });
});

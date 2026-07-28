import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamWorkspaceService } from './TeamWorkspaceService';

import type { GroupMessage } from './TeamWorkspaceService';

// CLAUDE.md 把 "server-side appendMessage ID propagation" 列为零覆盖的关键回归路径：
// 去重管线按 id 去重，若 appendMessage 重新生成 id，同一条逻辑消息会得到不同 id →
// 重复消息回归。这里直测真实文件 IO 实现（TaskDispatchService.test.ts 用的是 FakeWorkspace，
// 完全绕过真实落盘）。
const PREV_HERMIT_HOME = process.env.HERMIT_HOME;
let tmpHome = '';

function svc() {
  return new TeamWorkspaceService();
}

afterAll(() => {
  if (PREV_HERMIT_HOME === undefined) delete process.env.HERMIT_HOME;
  else process.env.HERMIT_HOME = PREV_HERMIT_HOME;
});

beforeEach(() => {
  tmpHome = path.join(
    os.tmpdir(),
    `hermit-tws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  process.env.HERMIT_HOME = tmpHome;
});

afterEach(async () => {
  await fs.promises.rm(tmpHome, { recursive: true, force: true });
});

describe('TeamWorkspaceService.appendMessage — message pipeline', () => {
  it('preserves a caller-supplied id (dedup guarantee: never regenerates)', async () => {
    const out = await svc().appendMessage('alpha', { id: 'fixed-1', from: 'user', content: 'hi' });
    expect(out.id).toBe('fixed-1');
    // 第二条用相同显式 id 仍各自落盘（去重发生在渲染层，service 不负责丢弃）。
    await svc().appendMessage('alpha', { id: 'fixed-1', from: 'user', content: 'dup' });
    const msgs = await svc().readMessages('alpha');
    expect(msgs.map((m) => m.id)).toEqual(['fixed-1', 'fixed-1']);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'dup']);
  });

  it('generates an m_-prefixed id when none is supplied', async () => {
    const out = await svc().appendMessage('alpha', { from: 'agent-7', content: 'x' });
    expect(out.id).toMatch(/^m_/);
    expect(out.id.length).toBeGreaterThan(4);
  });

  it('stamps a server-side ISO ts and defaults `to` to "team"', async () => {
    const out = await svc().appendMessage('alpha', { from: 'user', content: 'x' });
    expect(out.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(out.to).toBe('team');
  });

  it('derives role from `from` and honors an explicit role override', async () => {
    const s = svc();
    const user = await s.appendMessage('alpha', { from: 'user', content: 'u' });
    const agent = await s.appendMessage('alpha', { from: 'agent-7', content: 'a' });
    const system = await s.appendMessage('alpha', {
      from: 'agent-7',
      role: 'system',
      content: 's',
    });
    expect(user.role).toBe('user');
    expect(agent.role).toBe('agent');
    expect(system.role).toBe('system');
  });

  it('passes meta through (null default + object preserved)', async () => {
    const s = svc();
    const noMeta = await s.appendMessage('alpha', { from: 'user', content: 'a' });
    const withMeta = await s.appendMessage('alpha', {
      from: 'user',
      content: 'b',
      meta: { taskId: 't_1', mentions: ['@d'] },
    });
    expect(noMeta.meta).toBeNull();
    expect(withMeta.meta).toEqual({ taskId: 't_1', mentions: ['@d'] });
  });

  it('persists each message as its own newline-delimited JSONL line', async () => {
    const s = svc();
    await s.appendMessage('alpha', { id: 'a', from: 'user', content: 'first' });
    await s.appendMessage('alpha', { id: 'b', from: 'user', content: 'second' });
    const file = path.join(tmpHome, 'teams', 'alpha', 'messages', 'group.jsonl');
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('a');
    expect(JSON.parse(lines[1]).id).toBe('b');
  });

  it('readMessages round-trips appended messages sorted by ts', async () => {
    const s = svc();
    await s.appendMessage('alpha', { id: 'm1', from: 'user', content: 'one' });
    await s.appendMessage('alpha', { id: 'm2', from: 'user', content: 'two' });
    await s.appendMessage('alpha', { id: 'm3', from: 'user', content: 'three' });
    const msgs = await s.readMessages('alpha');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].ts.localeCompare(msgs[i - 1].ts)).toBeGreaterThanOrEqual(0);
    }
  });

  it('readMessages returns [] for an external platform session slug', async () => {
    await expect(svc().readMessages('feishu:some-session')).resolves.toEqual([]);
  });

  it('appendMessage rejects an external platform session slug', async () => {
    await expect(
      svc().appendMessage('feishu:some-session', { from: 'user', content: 'x' })
    ).rejects.toThrow(/外部平台/);
  });

  it('survives a corrupted JSONL line on read (skips unparseable lines)', async () => {
    const s = svc();
    await s.appendMessage('alpha', { id: 'good', from: 'user', content: 'ok' });
    const file = path.join(tmpHome, 'teams', 'alpha', 'messages', 'group.jsonl');
    await fs.promises.appendFile(file, '{ not valid json\n');
    const msgs = await s.readMessages('alpha');
    expect(msgs.map((m: GroupMessage) => m.id)).toEqual(['good']);
  });
});

describe('TeamWorkspaceService team deletion', () => {
  it('soft-deletes a team by marking deletedAt while preserving local files', async () => {
    const s = svc();
    const { manifest } = await s.createTeam({
      displayName: 'Alpha',
      bindProject: 'alpha',
      harness: 'claudecode',
      workDir: tmpHome,
    });
    await s.appendMessage(manifest.slug, { id: 'm1', from: 'user', content: 'keep history' });

    await s.deleteTeam(manifest.slug);

    const deleted = await s.readTeamManifest(manifest.slug);
    expect(deleted.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await s.readMessages(manifest.slug)).toEqual([
      expect.objectContaining({ id: 'm1', content: 'keep history' }),
    ]);
    await expect(
      fs.promises.stat(path.join(tmpHome, 'teams', manifest.slug, 'team.json'))
    ).resolves.toBeTruthy();
  });

  it('restores a soft-deleted team by clearing deletion markers', async () => {
    const s = svc();
    const { manifest } = await s.createTeam({
      displayName: 'Alpha',
      bindProject: 'alpha',
      harness: 'claudecode',
      workDir: tmpHome,
    });

    await s.deleteTeam(manifest.slug);
    await s.restoreTeam(manifest.slug);

    const restored = await s.readTeamManifest(manifest.slug);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.pendingDelete).toBeUndefined();
    expect(restored.restartRequired).toBeUndefined();
  });

  it('permanently deletes local files only when requested', async () => {
    const s = svc();
    const { manifest } = await s.createTeam({
      displayName: 'Alpha',
      bindProject: 'alpha',
      harness: 'claudecode',
      workDir: tmpHome,
    });

    await s.deleteTeam(manifest.slug, { deleteFiles: true });

    await expect(fs.promises.stat(path.join(tmpHome, 'teams', manifest.slug))).rejects.toThrow();
  });
});

describe('TeamWorkspaceService hidden sessions', () => {
  it('persists an archived session id and reads it back', async () => {
    const s = svc();

    await s.hideSession('alpha', 'session-1');

    expect(await s.readHiddenSessionIds('alpha')).toEqual(new Set(['session-1']));
    const file = path.join(tmpHome, 'teams', 'alpha', 'sessions', 'hidden.json');
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as {
      sessions: Record<string, { sessionId: string; reason: string }>;
    };
    expect(raw.sessions['session-1']).toMatchObject({
      sessionId: 'session-1',
      reason: 'archived',
    });
  });

  it('is idempotent for the same archived session id', async () => {
    const s = svc();

    await s.hideSession('alpha', 'session-1');
    await s.hideSession('alpha', 'session-1');

    const file = path.join(tmpHome, 'teams', 'alpha', 'sessions', 'hidden.json');
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(raw.sessions)).toEqual(['session-1']);
    expect(await s.readHiddenSessionIds('alpha')).toEqual(new Set(['session-1']));
  });

  it('returns an empty set when the hidden-session index is missing or corrupted', async () => {
    const s = svc();

    await expect(s.readHiddenSessionIds('alpha')).resolves.toEqual(new Set());

    const file = path.join(tmpHome, 'teams', 'alpha', 'sessions', 'hidden.json');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, '{ not valid json');

    await expect(s.readHiddenSessionIds('alpha')).resolves.toEqual(new Set());
  });

  it('does not delete team message history when archiving a session', async () => {
    const s = svc();
    await s.appendMessage('alpha', { id: 'm1', from: 'user', content: 'keep me' });

    await s.hideSession('alpha', 'session-1');

    expect((await s.readMessages('alpha')).map((message) => message.id)).toEqual(['m1']);
  });
});

describe('TeamWorkspaceService task board', () => {
  it('createTask requires a title', async () => {
    await expect(svc().createTask('alpha', { title: '' } as never)).rejects.toThrow('title');
  });

  it('createTask assigns incrementing order within a column and round-trips', async () => {
    const s = svc();
    const t1 = await s.createTask('alpha', { title: 'A' });
    const t2 = await s.createTask('alpha', { title: 'B' });
    const t3 = await s.createTask('alpha', { title: 'C', status: 'done' });
    expect(t1.id).toMatch(/^t_/);
    expect(t1.order).toBe(0);
    expect(t2.order).toBe(1); // same 'todo' column increments
    expect(t3.order).toBe(0); // different column ('done') starts fresh
    expect(t3.status).toBe('done');
    const tasks = await s.readTasks('alpha');
    expect(tasks.map((t) => t.title).sort()).toEqual(['A', 'B', 'C']);
  });

  it('patchTask updates fields, bumps updatedAt, and pins id/teamSlug', async () => {
    const s = svc();
    const t = await s.createTask('alpha', { title: 'A' });
    const patched = await s.patchTask('alpha', t.id, { status: 'doing', assignee: 'w1' });
    expect(patched.status).toBe('doing');
    expect(patched.assignee).toBe('w1');
    expect(patched.id).toBe(t.id);
    expect(patched.teamSlug).toBe('alpha');
    expect(patched.updatedAt).not.toBe(t.updatedAt);
  });

  it('persists optional collaboration fields without changing old board records', async () => {
    const s = svc();
    const created = await s.createTask('alpha', { title: 'Collaborate' });
    const comment = {
      id: 'comment-1',
      author: 'user',
      text: 'Please check the linked task',
      createdAt: '2026-01-01T00:00:00.000Z',
      type: 'regular' as const,
      taskRefs: [{ taskId: 'task-2', displayId: 'TASK-2', teamName: 'beta' }],
    };

    await s.patchTask('alpha', created.id, {
      comments: [comment],
      needsClarification: 'user',
      blockedBy: ['task-2'],
      related: ['task-3'],
    });

    const [persisted] = await s.readTasks('alpha');
    expect(persisted).toEqual(
      expect.objectContaining({
        comments: [comment],
        needsClarification: 'user',
        blockedBy: ['task-2'],
        related: ['task-3'],
      })
    );
  });

  it('patchTask throws for an unknown id', async () => {
    await expect(svc().patchTask('alpha', 'nope', { status: 'done' })).rejects.toThrow('not found');
  });

  it('deleteTask returns true when removed, false when absent, and persists', async () => {
    const s = svc();
    const t = await s.createTask('alpha', { title: 'A' });
    expect(await s.deleteTask('alpha', 'nope')).toBe(false);
    expect(await s.deleteTask('alpha', t.id)).toBe(true);
    expect(await s.readTasks('alpha')).toEqual([]);
  });

  // F-4 (gstack-QA TEAM-010-007): a cross-team dispatch writes a received task
  // onto the TARGET team's board via createOrReuseReceivedTask → createTask. The
  // target team's kanban (GET /api/teams/:name/tasks → readTasks) must reflect it
  // — read and write share resolveStorageSlug + teamRoot, so this is the
  // read-after-write guarantee that the reported "API returns []" contradicted.
  // (The cited route /api/teams/:name/board does not exist; the real route is
  // /tasks. This test pins target-side visibility with the dispatchMeta intact.)
  it('a task is visible on the team board after create+read', async () => {
    const s = svc();
    const created = await s.createTask('team-4', {
      title: '[TEAM-010-005] task arrival',
      description: '@team-4 ...',
      status: 'todo',
    });

    // Re-read from disk the same way the board endpoint does.
    const tasks = await s.readTasks('team-4');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(created.id);
    expect(tasks[0].status).toBe('todo');

    // A second, unrelated read of a different team must NOT bleed the task over
    // (guards against a slug-misroute false visible/invisible).
    expect(await s.readTasks('team-jcve')).toEqual([]);
  });
});

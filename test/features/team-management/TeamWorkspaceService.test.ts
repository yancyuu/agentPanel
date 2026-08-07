/**
 * Tests: TeamWorkspaceService — 团队本地存储 CRUD
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TeamWorkspaceService } from '@main/services/team-management/TeamWorkspaceService';

let tmpDir: string;
let svc: TeamWorkspaceService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-ws-test-'));
  process.env.HERMIT_HOME = tmpDir;
  svc = new TeamWorkspaceService();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HERMIT_HOME;
});

// ---------------------------------------------------------------------------
describe('createTeam', () => {
  it('creates team.json with correct fields', async () => {
    const { slug, manifest } = await svc.createTeam({
      displayName: '前端团队',
      bindProject: 'frontend-team',
      harness: 'claudecode',
      workDir: '/tmp/frontend',
      color: 'blue',
      collaboration: true,
    });

    expect(slug).toBe('frontend-team');
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.bindProject).toBe('frontend-team');
    expect(manifest.harness).toBe('claudecode');
    expect(manifest.workDir).toBe('/tmp/frontend');
    expect(manifest.collaboration).toBe(true);

    const teamJsonPath = path.join(tmpDir, 'teams', slug, 'team.json');
    const stored = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
    expect(stored.displayName).toBe('前端团队');
  });

  it('defaults collaboration to true', async () => {
    const { manifest } = await svc.createTeam({
      displayName: 'test-team',
      bindProject: 'test-cc',
      harness: 'codex',
      workDir: '/tmp/test',
    });
    expect(manifest.collaboration).toBe(true);
  });

  it('respects collaboration=false', async () => {
    const { manifest } = await svc.createTeam({
      displayName: 'solo-team',
      bindProject: 'solo-cc',
      harness: 'gemini',
      workDir: '/tmp/solo',
      collaboration: false,
    });
    expect(manifest.collaboration).toBe(false);
  });

  it('generates unique slug on collision', async () => {
    const { slug: s1 } = await svc.createTeam({
      displayName: '团队A',
      bindProject: 'alpha',
      harness: 'claudecode',
      workDir: '/tmp/a',
    });
    const { slug: s2 } = await svc.createTeam({
      displayName: '团队A',
      bindProject: 'alpha-2',
      harness: 'claudecode',
      workDir: '/tmp/b',
    });
    expect(s1).toBe('alpha');
    expect(s2).toBe('alpha-2');
  });

  it('preserves Chinese displayName while using ASCII bindProject as slug', async () => {
    const { slug, manifest } = await svc.createTeam({
      displayName: '产品经理团队',
      bindProject: 'team-abcd',
      harness: 'claudecode',
      workDir: '/tmp/pm',
    });

    expect(slug).toBe('team-abcd');
    expect(manifest.displayName).toBe('产品经理团队');
    expect(manifest.bindProject).toBe('team-abcd');
    expect(fs.existsSync(path.join(tmpDir, 'teams', 'team'))).toBe(false);
  });

  it('rejects invalid bindProject before creating a fallback team directory', async () => {
    await expect(
      svc.createTeam({
        displayName: '产品经理团队',
        bindProject: '产品经理团队',
        harness: 'claudecode',
        workDir: '/tmp/pm',
      })
    ).rejects.toThrow(/bindProject/);

    await expect(
      svc.createTeam({
        displayName: 'Bad Project',
        bindProject: 'Bad Project',
        harness: 'claudecode',
        workDir: '/tmp/bad',
      })
    ).rejects.toThrow(/bindProject/);

    expect(fs.existsSync(path.join(tmpDir, 'teams', 'team'))).toBe(false);
  });

  it('throws if displayName missing', async () => {
    await expect(
      svc.createTeam({ displayName: '', bindProject: 'p', harness: 'codex', workDir: '/tmp' })
    ).rejects.toThrow('displayName is required');
  });
});

// ---------------------------------------------------------------------------
describe('listTeams / readTeamManifest', () => {
  it('returns empty array when no teams', async () => {
    expect(await svc.listTeams()).toEqual([]);
  });

  it('lists created teams sorted by createdAt desc', async () => {
    await svc.createTeam({
      displayName: '团队A',
      bindProject: 'team-a',
      harness: 'claudecode',
      workDir: '/tmp/a',
    });
    await new Promise((r) => setTimeout(r, 10));
    await svc.createTeam({
      displayName: '团队B',
      bindProject: 'team-b',
      harness: 'codex',
      workDir: '/tmp/b',
    });
    const teams = await svc.listTeams();
    expect(teams[0].slug).toBe('team-b');
    expect(teams[1].slug).toBe('team-a');
  });

  it('throws for non-existent team', async () => {
    await expect(svc.readTeamManifest('no-such-team')).rejects.toThrow();
  });

  it('resolves legacy slug by bindProject', async () => {
    const root = path.join(tmpDir, 'teams', 'team');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'team.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          slug: 'team',
          displayName: '产品经理团队',
          bindProject: 'pm-team-1234',
          harness: 'claudecode',
          workDir: '/tmp/pm',
          collaboration: true,
          rootPath: root,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    expect((await svc.readTeamManifest('team')).bindProject).toBe('pm-team-1234');
    expect((await svc.readTeamManifest('pm-team-1234')).slug).toBe('team');
  });
});

// ---------------------------------------------------------------------------
describe('updateTeam', () => {
  it('updates color and collaboration', async () => {
    const { slug } = await svc.createTeam({
      displayName: 'upd-team',
      bindProject: 'p',
      harness: 'qoder',
      workDir: '/tmp/u',
    });
    const updated = await svc.updateTeam(slug, { color: 'rose', collaboration: false });
    expect(updated.color).toBe('rose');
    expect(updated.collaboration).toBe(false);

    // persisted
    const reread = await svc.readTeamManifest(slug);
    expect(reread.collaboration).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('deleteTeam', () => {
  it('soft-deletes team metadata by default without moving local files', async () => {
    const { slug, manifest } = await svc.createTeam({
      displayName: 'del-team',
      bindProject: 'p',
      harness: 'claudecode',
      workDir: '/tmp/d',
    });
    expect(fs.existsSync(manifest.rootPath)).toBe(true);
    await svc.deleteTeam(slug);
    expect(fs.existsSync(manifest.rootPath)).toBe(true);
    const deleted = await svc.readTeamManifest(slug);
    expect(deleted.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const archived = fs
      .readdirSync(path.join(tmpDir, 'teams'))
      .find((e) => e.startsWith('.archived-'));
    expect(archived).toBeUndefined();
  });

  it('deletes files when deleteFiles=true', async () => {
    const { slug, manifest } = await svc.createTeam({
      displayName: 'del2',
      bindProject: 'p',
      harness: 'claudecode',
      workDir: '/tmp/d2',
    });
    await svc.deleteTeam(slug, { deleteFiles: true });
    expect(fs.existsSync(manifest.rootPath)).toBe(false);
  });

  it('deletes legacy local directory when called with bindProject', async () => {
    const root = path.join(tmpDir, 'teams', 'team');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'team.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          slug: 'team',
          displayName: '产品经理团队',
          bindProject: 'pm-team-1234',
          harness: 'claudecode',
          workDir: '/tmp/pm',
          collaboration: true,
          rootPath: root,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    await svc.deleteTeam('pm-team-1234', { deleteFiles: true });
    expect(fs.existsSync(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('tasks CRUD', () => {
  let teamSlug: string;

  beforeEach(async () => {
    const { slug } = await svc.createTeam({
      displayName: 'task-team',
      bindProject: 'p',
      harness: 'claudecode',
      workDir: '/tmp/t',
    });
    teamSlug = slug;
  });

  it('createTask returns task with generated id', async () => {
    const task = await svc.createTask(teamSlug, { title: 'fix bug', description: 'desc' });
    expect(task.id).toMatch(/^t_/);
    expect(task.title).toBe('fix bug');
    expect(task.status).toBe('todo');
    expect(task.assignee).toBeNull();
    expect(task.deliveries).toBeUndefined();
  });

  it('readTasks returns all tasks', async () => {
    await svc.createTask(teamSlug, { title: 'task-1' });
    await svc.createTask(teamSlug, { title: 'task-2' });
    const tasks = await svc.readTasks(teamSlug);
    expect(tasks).toHaveLength(2);
  });

  it('projects legacy result fields into deliveries and preserves legacy soft deletes', async () => {
    const now = '2026-01-02T03:04:05.000Z';
    const boardPath = path.join(tmpDir, 'teams', teamSlug, 'tasks', 'board.json');
    fs.writeFileSync(
      boardPath,
      JSON.stringify({
        tasks: [
          {
            id: 'legacy-result',
            teamSlug,
            title: '旧成果',
            status: 'done',
            result: '历史交付正文',
            createdAt: now,
            updatedAt: now,
            order: 0,
          },
          {
            id: 'legacy-deleted',
            teamSlug,
            title: '旧删除任务',
            status: 'done',
            result: '__deleted__',
            createdAt: now,
            updatedAt: now,
            order: 1,
          },
        ],
      })
    );

    const tasks = await svc.readTasks(teamSlug);
    expect(tasks.find((task) => task.id === 'legacy-result')?.deliveries).toEqual([
      { version: 1, result: '历史交付正文', deliveredAt: now },
    ]);
    expect(tasks.find((task) => task.id === 'legacy-deleted')?.deletedAt).toBe(now);

    await svc.patchTask(teamSlug, 'legacy-result', { status: 'done' });
    const persisted = JSON.parse(fs.readFileSync(boardPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(persisted.tasks.find((task) => task.id === 'legacy-result')).toMatchObject({
      deliveries: [{ version: 1, result: '历史交付正文', deliveredAt: now }],
    });
    expect(persisted.tasks.find((task) => task.id === 'legacy-result')).not.toHaveProperty(
      'result'
    );
    expect(persisted.tasks.find((task) => task.id === 'legacy-deleted')).toMatchObject({
      deletedAt: now,
    });
  });

  it('patchTask updates fields', async () => {
    const t = await svc.createTask(teamSlug, { title: 'original' });
    const patched = await svc.patchTask(teamSlug, t.id, {
      status: 'doing',
      assignee: 'other-team',
    });
    expect(patched.status).toBe('doing');
    expect(patched.assignee).toBe('other-team');
    expect(patched.id).toBe(t.id);
  });

  it('patchTask supports deletedAt soft delete', async () => {
    const t = await svc.createTask(teamSlug, { title: 'to soft delete' });
    const deletedAt = new Date().toISOString();
    const deleted = await svc.patchTask(teamSlug, t.id, { status: 'done', deletedAt });
    expect(deleted.deletedAt).toBe(deletedAt);
    expect(deleted.status).toBe('done');
    const reread = (await svc.readTasks(teamSlug)).find((task) => task.id === t.id);
    expect(reread?.deletedAt).toBe(deletedAt);

    const restored = await svc.patchTask(teamSlug, t.id, { status: 'todo', deletedAt: null });
    expect(restored.deletedAt).toBeNull();
    const rereadRestored = (await svc.readTasks(teamSlug)).find((task) => task.id === t.id);
    expect(rereadRestored?.deletedAt).toBeNull();
  });

  it('deleteTask removes task', async () => {
    const t = await svc.createTask(teamSlug, { title: 'to delete' });
    expect(await svc.deleteTask(teamSlug, t.id)).toBe(true);
    expect(await svc.readTasks(teamSlug)).toHaveLength(0);
  });

  it('deleteTask returns false for unknown id', async () => {
    expect(await svc.deleteTask(teamSlug, 'non-existent')).toBe(false);
  });

  it('createTask throws if title missing', async () => {
    await expect(svc.createTask(teamSlug, { title: '' })).rejects.toThrow('title is required');
  });
});

// ---------------------------------------------------------------------------
describe('deliveries / feedbackItems / historyEvents', () => {
  let teamSlug: string;

  beforeEach(async () => {
    const { slug } = await svc.createTeam({
      displayName: 'delivery-team',
      bindProject: 'p',
      harness: 'claudecode',
      workDir: '/tmp/t',
    });
    teamSlug = slug;
  });

  it('addDelivery increments version and skips unknown or already-resolved feedback ids', async () => {
    const t = await svc.createTask(teamSlug, { title: 'deliverable' });

    const first = await svc.addDelivery(teamSlug, t.id, { result: '第一版成果' });
    expect(first.delivery.version).toBe(1);
    expect(first.delivery.result).toBe('第一版成果');
    expect(first.delivery.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.skippedFeedbackIds).toEqual([]);

    const openItem = await svc.addFeedbackItem(teamSlug, t.id, { text: '请补充数据来源' });
    const second = await svc.addDelivery(teamSlug, t.id, {
      result: '第二版成果',
      summary: '补充了数据来源',
      addressedFeedbackIds: [openItem.id, 'f_unknown'],
    });
    expect(second.delivery.version).toBe(2);
    expect(second.delivery.summary).toBe('补充了数据来源');
    expect(second.delivery.addressedFeedbackIds).toEqual([openItem.id, 'f_unknown']);
    expect(second.skippedFeedbackIds).toEqual(['f_unknown']);
    expect(second.task.deliveries).toHaveLength(2);
    expect(second.task.feedbackItems).toEqual([
      expect.objectContaining({
        id: openItem.id,
        status: 'resolved',
        resolvedAt: expect.any(String),
      }),
    ]);

    // 已 resolved 的条目再次标记会被跳过
    const third = await svc.addDelivery(teamSlug, t.id, {
      result: '第三版成果',
      addressedFeedbackIds: [openItem.id],
    });
    expect(third.delivery.version).toBe(3);
    expect(third.skippedFeedbackIds).toEqual([openItem.id]);
  });

  it('addDelivery rejects empty result', async () => {
    const t = await svc.createTask(teamSlug, { title: 'deliverable' });
    await expect(svc.addDelivery(teamSlug, t.id, { result: '   ' })).rejects.toThrow(
      '交付结果不能为空'
    );
  });

  it('addFeedbackItem creates an open item with f_ id and anchor passthrough', async () => {
    const t = await svc.createTask(teamSlug, { title: 'reviewable' });
    const item = await svc.addFeedbackItem(teamSlug, t.id, {
      text: '结论缺少风险分析',
      anchor: { kind: 'quote', quote: '第三段结论' },
    });
    expect(item.id).toMatch(/^f_/);
    expect(item.status).toBe('open');
    expect(item.anchor).toEqual({ kind: 'quote', quote: '第三段结论' });
    const stored = (await svc.readTasks(teamSlug)).find((task) => task.id === t.id);
    expect(stored?.feedbackItems).toEqual([item]);
  });

  it('addFeedbackItem rejects empty text', async () => {
    const t = await svc.createTask(teamSlug, { title: 'reviewable' });
    await expect(svc.addFeedbackItem(teamSlug, t.id, { text: ' ' })).rejects.toThrow(
      '反馈内容不能为空'
    );
  });

  it('appendTaskHistoryEvent only appends and never mutates existing events', async () => {
    const t = await svc.createTask(teamSlug, { title: 'eventful' });
    const first = {
      id: 'e_1',
      type: 'review_requested',
      from: 'none',
      to: 'review',
      timestamp: new Date().toISOString(),
      actor: 'agent',
    } as const;
    const second = {
      id: 'e_2',
      type: 'review_changes_requested',
      from: 'review',
      to: 'needsFix',
      timestamp: new Date().toISOString(),
      actor: 'reviewer',
    } as const;
    await svc.appendTaskHistoryEvent(teamSlug, t.id, { ...first });
    await svc.appendTaskHistoryEvent(teamSlug, t.id, { ...second });
    const stored = (await svc.readTasks(teamSlug)).find((task) => task.id === t.id);
    expect(stored?.historyEvents).toEqual([first, second]);
  });

});

// ---------------------------------------------------------------------------
describe('review decisions', () => {
  let teamSlug: string;

  beforeEach(async () => {
    const { slug } = await svc.createTeam({
      displayName: 'review-team',
      bindProject: 'p',
      harness: 'claudecode',
      workDir: '/tmp/t',
    });
    teamSlug = slug;
  });

  it('serializes concurrent saves so independent scopes are not lost', async () => {
    await Promise.all([
      svc.saveReviewDecision(teamSlug, 'scope-a', {
        hunkDecisions: { a: 'approved' },
        fileDecisions: {},
      }),
      svc.saveReviewDecision(teamSlug, 'scope-b', {
        hunkDecisions: { b: 'rejected' },
        fileDecisions: {},
      }),
    ]);

    expect(await svc.readReviewDecisions(teamSlug)).toMatchObject({
      'scope-a': { hunkDecisions: { a: 'approved' }, fileDecisions: {} },
      'scope-b': { hunkDecisions: { b: 'rejected' }, fileDecisions: {} },
    });
  });

  it('serializes concurrent save and clear mutations', async () => {
    await svc.saveReviewDecision(teamSlug, 'scope-remove', {
      hunkDecisions: {},
      fileDecisions: { old: 'approved' },
    });

    await Promise.all([
      svc.clearReviewDecision(teamSlug, 'scope-remove'),
      svc.saveReviewDecision(teamSlug, 'scope-keep', {
        hunkDecisions: {},
        fileDecisions: { current: 'approved' },
      }),
    ]);

    expect(await svc.readReviewDecisions(teamSlug)).toEqual({
      'scope-keep': {
        hunkDecisions: {},
        fileDecisions: { current: 'approved' },
      },
    });
  });

  it('saves, overwrites, loads and clears decisions per scopeKey', async () => {
    expect(await svc.readReviewDecisions(teamSlug)).toEqual({});

    await svc.saveReviewDecision(teamSlug, 'scope-1', {
      scopeToken: 'token-1',
      hunkDecisions: { 'src/a.ts:0': 'approved' },
      fileDecisions: { 'src/a.ts': 'approved' },
    });
    await svc.saveReviewDecision(teamSlug, 'scope-2', {
      hunkDecisions: {},
      fileDecisions: { 'src/b.ts': 'rejected' },
    });

    // 覆盖写同一 scopeKey
    await svc.saveReviewDecision(teamSlug, 'scope-1', {
      scopeToken: 'token-2',
      hunkDecisions: { 'src/a.ts:0': 'rejected' },
      fileDecisions: {},
    });
    const all = await svc.readReviewDecisions(teamSlug);
    expect(all['scope-1']).toEqual({
      scopeToken: 'token-2',
      hunkDecisions: { 'src/a.ts:0': 'rejected' },
      fileDecisions: {},
    });
    expect(all['scope-2']).toEqual({
      hunkDecisions: {},
      fileDecisions: { 'src/b.ts': 'rejected' },
    });

    await svc.clearReviewDecision(teamSlug, 'scope-1');
    const afterClear = await svc.readReviewDecisions(teamSlug);
    expect(afterClear['scope-1']).toBeUndefined();
    expect(afterClear['scope-2']).toBeDefined();

    // clear 不存在的 scopeKey 是 no-op
    await svc.clearReviewDecision(teamSlug, 'scope-missing');
    expect(await svc.readReviewDecisions(teamSlug)).toEqual(afterClear);
  });
});

// ---------------------------------------------------------------------------
describe('messages', () => {
  it('resolves bindProject to the storage slug when appending and reading messages', async () => {
    const root = path.join(tmpDir, 'teams', 'team');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'team.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          slug: 'team',
          displayName: '产品经理团队',
          bindProject: 'pm-team-1234',
          harness: 'claudecode',
          workDir: '/tmp/pm',
          collaboration: true,
          rootPath: root,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    await svc.appendMessage('pm-team-1234', {
      from: 'user',
      content: 'hello from bound project',
    });

    expect(fs.existsSync(path.join(tmpDir, 'teams', 'pm-team-1234'))).toBe(false);
    const messages = await svc.readMessages('pm-team-1234');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello from bound project');
  });

  it('routes raw external platform session keys via allow lists instead of creating feishu team dirs', async () => {
    const { slug } = await svc.createTeam({
      displayName: 'hermit开发',
      bindProject: 'hermit-dev',
      harness: 'claudecode',
      workDir: '/tmp/hermit',
    });
    await svc.updateTeam(slug, {
      platformAllowFrom: { feishu: 'ou_user' },
      platformAllowChat: { feishu: 'chat_A' },
    });

    await svc.appendMessage('feishu:chat_A:ou_user', {
      from: 'agent',
      content: 'routed from feishu',
      meta: { sessionKey: 'feishu:chat_A:ou_user' },
    });

    expect(fs.existsSync(path.join(tmpDir, 'teams', 'feishu:chat_A:ou_user'))).toBe(false);
    const messages = await svc.readMessages(slug);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('routed from feishu');
  });

  it('refuses to create message storage for unmapped raw external platform session keys', async () => {
    await expect(
      svc.appendMessage('feishu:chat_A:ou_user', {
        from: 'agent',
        content: 'should not create a feishu team directory',
      })
    ).rejects.toThrow(/外部平台 session_key/);

    expect(fs.existsSync(path.join(tmpDir, 'teams', 'feishu:chat_A:ou_user'))).toBe(false);
    await expect(svc.readMessages('feishu:chat_A:ou_user')).resolves.toEqual([]);
  });

  // Legacy `feishu:*` directory names contain ':' — they cannot exist on
  // Windows filesystems at all, so this migration scenario is POSIX-only.
  it.skipIf(process.platform === 'win32')(
    'includes legacy feishu:* message directories that now map to a Hermit team',
    async () => {
      const { slug } = await svc.createTeam({
        displayName: 'hermit开发',
        bindProject: 'hermit-dev',
        harness: 'claudecode',
        workDir: '/tmp/hermit',
      });
      await svc.updateTeam(slug, {
        platformAllowFrom: { feishu: '*' },
        platformAllowChat: { feishu: '*' },
      });
      await svc.appendMessage(slug, { from: 'user', content: 'current message' });

      const legacyRoot = path.join(tmpDir, 'teams', 'feishu:chat_A:ou_user', 'messages');
      fs.mkdirSync(legacyRoot, { recursive: true });
      fs.writeFileSync(
        path.join(legacyRoot, 'group.jsonl'),
        JSON.stringify({
          id: 'legacy-1',
          ts: '2026-01-01T00:00:00.000Z',
          from: 'feishu:chat_A:ou_user',
          to: 'user',
          role: 'agent',
          content: 'legacy message',
          meta: { sessionKey: 'feishu:chat_A:ou_user' },
        }) + '\n'
      );

      const messages = await svc.readMessages(slug);
      expect(messages.map((message) => message.content)).toEqual([
        'legacy message',
        'current message',
      ]);
    }
  );
});

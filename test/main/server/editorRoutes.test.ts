import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerEditorRoutes } from '../../../src/main/routes/editorRoutes';

const apps: ReturnType<typeof Fastify>[] = [];
const tempDirs: string[] = [];

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentcli-editor-routes-'));
  tempDirs.push(root);
  const app = Fastify({ logger: false });
  apps.push(app);
  registerEditorRoutes(app);
  return { app, root };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('editor routes', () => {
  it('opens project roots but rejects sensitive roots and traversal', async () => {
    const { app, root } = await createHarness();

    const opened = await app.inject({
      method: 'POST',
      url: '/api/editor/open',
      payload: { root },
    });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/editor/open',
      payload: { root: os.homedir() },
    });
    const traversal = await app.inject({
      method: 'GET',
      url: '/api/editor/readFile',
      query: { root, filePath: '../outside.txt' },
    });

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ ok: true, root });
    expect(forbidden.statusCode).toBe(500);
    expect(forbidden.json().error).toContain('不允许');
    expect(traversal.statusCode).toBe(500);
    expect(traversal.json()).toEqual({ error: '路径超出项目根目录' });
  });

  it('lists directories and reads text and binary files with existing metadata', async () => {
    const { app, root } = await createHarness();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'hello.txt'), '你好', 'utf8');
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2]));

    const directory = await app.inject({
      method: 'GET',
      url: '/api/editor/readDir',
      query: { root, dirPath: root, maxEntries: '10' },
    });
    const text = await app.inject({
      method: 'GET',
      url: '/api/editor/readFile',
      query: { root, filePath: 'src/hello.txt' },
    });
    const binary = await app.inject({
      method: 'GET',
      url: '/api/editor/readFile',
      query: { root, filePath: 'binary.bin' },
    });

    expect(directory.json()).toMatchObject({
      truncated: false,
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'binary.bin', type: 'file', size: 3 },
      ],
    });
    expect(text.json()).toMatchObject({
      content: '你好',
      encoding: 'utf-8',
      isBinary: false,
      truncated: false,
    });
    expect(binary.json()).toMatchObject({
      content: '',
      encoding: 'binary',
      isBinary: true,
      size: 3,
    });
  });

  it('preserves write conflicts and file CRUD operations inside the root', async () => {
    const { app, root } = await createHarness();
    const existing = path.join(root, 'existing.txt');
    await writeFile(existing, 'before', 'utf8');

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/editor/writeFile',
      payload: {
        root,
        filePath: existing,
        content: 'conflict',
        baselineMtimeMs: 0,
      },
    });
    const written = await app.inject({
      method: 'POST',
      url: '/api/editor/writeFile',
      payload: { root, filePath: existing, content: 'after' },
    });
    const createdDir = await app.inject({
      method: 'POST',
      url: '/api/editor/createDir',
      payload: { root, parentDir: root, dirName: 'nested' },
    });
    const createdFile = await app.inject({
      method: 'POST',
      url: '/api/editor/createFile',
      payload: { root, parentDir: path.join(root, 'nested'), fileName: 'new.txt' },
    });
    const renamed = await app.inject({
      method: 'POST',
      url: '/api/editor/renameFile',
      payload: {
        root,
        sourcePath: path.join(root, 'nested', 'new.txt'),
        newName: 'renamed.txt',
      },
    });
    const deleted = await app.inject({
      method: 'POST',
      url: '/api/editor/deleteFile',
      payload: { root, filePath: path.join(root, 'nested', 'renamed.txt') },
    });

    expect(conflict.statusCode).toBe(500);
    expect(conflict.json().error).toContain('CONFLICT');
    expect(written.statusCode).toBe(200);
    expect(await readFile(existing, 'utf8')).toBe('after');
    expect(createdDir.json()).toEqual({ dirPath: path.join(root, 'nested') });
    expect(createdFile.json()).toMatchObject({
      filePath: path.join(root, 'nested', 'new.txt'),
    });
    expect(renamed.json()).toEqual({
      newPath: path.join(root, 'nested', 'renamed.txt'),
      isDirectory: false,
    });
    expect(deleted.json()).toEqual({
      deletedPath: path.join(root, 'nested', 'renamed.txt'),
    });
  });

  it('rejects read, write and creation through symlinks that escape the project root', async () => {
    const { app, root } = await createHarness();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentcli-editor-outside-'));
    tempDirs.push(outside);
    const outsideFile = path.join(outside, 'secret.txt');
    await writeFile(outsideFile, 'outside-original', 'utf8');
    await symlink(outside, path.join(root, 'escape'), 'dir');

    const read = await app.inject({
      method: 'GET',
      url: '/api/editor/readFile',
      query: { root, filePath: 'escape/secret.txt' },
    });
    const write = await app.inject({
      method: 'POST',
      url: '/api/editor/writeFile',
      payload: { root, filePath: 'escape/secret.txt', content: 'mutated' },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/editor/createFile',
      payload: { root, parentDir: 'escape', fileName: 'created.txt' },
    });
    const directory = await app.inject({
      method: 'GET',
      url: '/api/editor/readDir',
      query: { root, dirPath: 'escape' },
    });

    for (const response of [read, write, create, directory]) {
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toContain('符号链接');
    }
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original');
    await expect(readFile(path.join(outside, 'created.txt'), 'utf8')).rejects.toThrow();
  });

  it('keeps editor compatibility stubs stable', async () => {
    const { app } = await createHarness();

    const gitStatus = await app.inject({ method: 'GET', url: '/api/editor/gitStatus' });
    const search = await app.inject({ method: 'GET', url: '/api/editor/search' });
    const close = await app.inject({ method: 'POST', url: '/api/editor/close' });

    expect(gitStatus.json()).toEqual({ files: [], isGitRepo: false, branch: null });
    expect(search.json()).toEqual({ results: [], totalMatches: 0, truncated: false });
    expect(close.json()).toEqual({ ok: true });
  });
});

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

const MAX_EDITOR_DIR_ENTRIES = 2000;
const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

function resolveEditorRoot(rawRoot: unknown): string {
  if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
    throw new Error('root 参数不能为空');
  }
  const resolved = path.resolve(rawRoot.trim());
  const home = os.homedir();
  const forbiddenRoots = new Set([
    path.parse(resolved).root,
    home,
    path.join(home, '.ssh'),
    path.join(home, '.hermit'),
  ]);
  if (forbiddenRoots.has(resolved)) {
    throw new Error('不允许将该目录作为项目根目录');
  }
  if (!existsSync(resolved)) {
    throw new Error(`目录不存在: ${resolved}`);
  }
  const stats = statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`不是目录: ${resolved}`);
  }
  return resolved;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveEditorPath(root: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('filePath/dirPath 参数不能为空');
  }
  const requested = rawPath.trim();
  const resolved = path.resolve(
    path.isAbsolute(requested) ? requested : path.join(root, requested)
  );
  if (!isPathInsideRoot(root, resolved)) {
    throw new Error('路径超出项目根目录');
  }
  return resolved;
}

function detectBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function sendEditorError(
  reply: { code: (statusCode: number) => { send: (payload: { error: string }) => unknown } },
  error: unknown
): unknown {
  return reply.code(500).send({
    error: error instanceof Error ? error.message : String(error),
  });
}

export function registerEditorRoutes(app: FastifyInstance): void {
  app.post<{ Body: { root?: unknown } }>('/api/editor/open', async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      return { ok: true, root };
    } catch (error) {
      return sendEditorError(reply, error);
    }
  });

  app.post('/api/editor/close', async () => ({ ok: true }));

  app.get<{ Querystring: { root?: unknown; dirPath?: unknown; maxEntries?: string } }>(
    '/api/editor/readDir',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.query.root);
        const dirPath = request.query.dirPath
          ? resolveEditorPath(root, request.query.dirPath)
          : root;
        const maxEntriesRaw = Number.parseInt(request.query.maxEntries ?? '', 10);
        const maxEntries = Number.isFinite(maxEntriesRaw)
          ? Math.min(Math.max(maxEntriesRaw, 1), MAX_EDITOR_DIR_ENTRIES)
          : MAX_EDITOR_DIR_ENTRIES;
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const mapped = entries
          .slice(0, maxEntries)
          .map((entry) => {
            const fullPath = path.join(dirPath, entry.name);
            let size = 0;
            try {
              size = entry.isFile() ? statSync(fullPath).size : 0;
            } catch {
              size = 0;
            }
            return {
              name: entry.name,
              path: fullPath,
              type: entry.isDirectory() ? 'directory' : 'file',
              size,
            };
          })
          .sort((left, right) => {
            if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
            return left.name.localeCompare(right.name);
          });
        return {
          entries: mapped,
          truncated: entries.length > maxEntries,
        };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.get<{ Querystring: { root?: unknown; filePath?: unknown } }>(
    '/api/editor/readFile',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.query.root);
        const filePath = resolveEditorPath(root, request.query.filePath);
        const stats = statSync(filePath);
        if (!stats.isFile()) throw new Error(`不是文件: ${filePath}`);

        const fullBuffer = readFileSync(filePath);
        const truncated = fullBuffer.length > MAX_EDITOR_FILE_BYTES;
        const readBuffer = truncated ? fullBuffer.subarray(0, MAX_EDITOR_FILE_BYTES) : fullBuffer;
        const isBinary = detectBinary(readBuffer);
        return {
          content: isBinary ? '' : readBuffer.toString('utf8'),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          truncated,
          encoding: isBinary ? 'binary' : 'utf-8',
          isBinary,
        };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.post<{
    Body: { root?: unknown; filePath?: unknown; content?: unknown; baselineMtimeMs?: unknown };
  }>('/api/editor/writeFile', async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.body?.root);
      const filePath = resolveEditorPath(root, request.body?.filePath);
      const content = request.body?.content;
      if (typeof content !== 'string') throw new Error('content 必须是字符串');
      const baseline = request.body?.baselineMtimeMs;
      if (typeof baseline === 'number' && Number.isFinite(baseline)) {
        const currentMtime = statSync(filePath).mtimeMs;
        if (Math.abs(currentMtime - baseline) > 1) {
          throw new Error('CONFLICT: file changed on disk');
        }
      }
      writeFileSync(filePath, content, 'utf8');
      const stats = statSync(filePath);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      return sendEditorError(reply, error);
    }
  });

  app.post<{ Body: { root?: unknown; parentDir?: unknown; fileName?: unknown } }>(
    '/api/editor/createFile',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.body?.root);
        const parentDir = resolveEditorPath(root, request.body?.parentDir);
        const fileName =
          typeof request.body?.fileName === 'string' ? request.body.fileName.trim() : '';
        if (!fileName) throw new Error('fileName 不能为空');
        const filePath = resolveEditorPath(root, path.join(parentDir, fileName));
        writeFileSync(filePath, '', { encoding: 'utf8', flag: 'wx' });
        return { filePath, mtimeMs: statSync(filePath).mtimeMs };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.post<{ Body: { root?: unknown; parentDir?: unknown; dirName?: unknown } }>(
    '/api/editor/createDir',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.body?.root);
        const parentDir = resolveEditorPath(root, request.body?.parentDir);
        const dirName =
          typeof request.body?.dirName === 'string' ? request.body.dirName.trim() : '';
        if (!dirName) throw new Error('dirName 不能为空');
        const dirPath = resolveEditorPath(root, path.join(parentDir, dirName));
        mkdirSync(dirPath, { recursive: false });
        return { dirPath };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.post<{ Body: { root?: unknown; filePath?: unknown } }>(
    '/api/editor/deleteFile',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.body?.root);
        const filePath = resolveEditorPath(root, request.body?.filePath);
        rmSync(filePath, { recursive: true, force: false });
        return { deletedPath: filePath };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.post<{ Body: { root?: unknown; sourcePath?: unknown; destDir?: unknown } }>(
    '/api/editor/moveFile',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.body?.root);
        const sourcePath = resolveEditorPath(root, request.body?.sourcePath);
        const destDir = resolveEditorPath(root, request.body?.destDir);
        const newPath = resolveEditorPath(root, path.join(destDir, path.basename(sourcePath)));
        const sourceStats = statSync(sourcePath);
        renameSync(sourcePath, newPath);
        return { newPath, isDirectory: sourceStats.isDirectory() };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.post<{ Body: { root?: unknown; sourcePath?: unknown; newName?: unknown } }>(
    '/api/editor/renameFile',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.body?.root);
        const sourcePath = resolveEditorPath(root, request.body?.sourcePath);
        const newName =
          typeof request.body?.newName === 'string' ? request.body.newName.trim() : '';
        if (!newName) throw new Error('newName 不能为空');
        const newPath = resolveEditorPath(root, path.join(path.dirname(sourcePath), newName));
        const sourceStats = statSync(sourcePath);
        renameSync(sourcePath, newPath);
        return { newPath, isDirectory: sourceStats.isDirectory() };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.get<{ Querystring: { root?: unknown } }>('/api/editor/listFiles', async (request, reply) => {
    try {
      const root = resolveEditorRoot(request.query.root);
      const result: { path: string; name: string; relativePath: string }[] = [];
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== '.git' && entry.name !== 'node_modules') walk(fullPath);
          } else if (entry.isFile()) {
            result.push({
              path: fullPath,
              name: entry.name,
              relativePath: path.relative(root, fullPath),
            });
          }
        }
      };
      walk(root);
      return result;
    } catch (error) {
      return sendEditorError(reply, error);
    }
  });

  app.get<{ Querystring: { root?: unknown; filePath?: unknown } }>(
    '/api/editor/readBinaryPreview',
    async (request, reply) => {
      try {
        const root = resolveEditorRoot(request.query.root);
        const filePath = resolveEditorPath(root, request.query.filePath);
        const content = readFileSync(filePath);
        return {
          base64: content.toString('base64'),
          mimeType: 'application/octet-stream',
          size: content.length,
        };
      } catch (error) {
        return sendEditorError(reply, error);
      }
    }
  );

  app.get('/api/editor/gitStatus', async () => ({
    files: [],
    isGitRepo: false,
    branch: null,
  }));
  app.post('/api/editor/watchDir', async () => ({ ok: true }));
  app.post('/api/editor/setWatchedFiles', async () => ({ ok: true }));
  app.post('/api/editor/setWatchedDirs', async () => ({ ok: true }));
  app.get('/api/editor/search', async () => ({
    results: [],
    totalMatches: 0,
    truncated: false,
  }));
}

import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  app.post<{ Body: { path?: string; limit?: number } }>(
    '/api/config/browse-folders',
    async (request) => {
      const { path: directoryPath, limit = 200 } = request.body ?? {};
      const target = directoryPath?.trim() ? directoryPath.trim() : os.homedir();

      try {
        const entries = readdirSync(target, { withFileTypes: true });
        const directories = entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .slice(0, limit)
          .map((entry) => path.join(target, entry.name));
        return {
          success: true,
          data: {
            path: target,
            dirs: directories,
            hasParent: target !== path.dirname(target),
          },
        };
      } catch {
        return { success: false, error: `无法访问目录: ${target}` };
      }
    }
  );

  app.post<{ Body: { dirPath?: string } }>('/api/workspace/list', async (request) => {
    const { dirPath } = request.body ?? {};
    const target = dirPath?.trim() ? dirPath.trim() : os.homedir();

    try {
      const entries = readdirSync(target, { withFileTypes: true });
      const files = entries.slice(0, 500).map((entry) => {
        const fullPath = path.join(target, entry.name);
        const isDirectory = entry.isDirectory();
        let size = 0;
        try {
          size = statSync(fullPath).size;
        } catch {
          // Preserve the existing best-effort metadata behavior.
        }
        return {
          name: entry.name,
          isDirectory,
          size,
          ext: isDirectory ? '' : path.extname(entry.name).slice(1).toLowerCase(),
        };
      });
      return {
        path: target,
        files,
        hasParent: target !== path.dirname(target),
      };
    } catch {
      return {
        path: target,
        files: [],
        hasParent: false,
        error: `无法访问目录: ${target}`,
      };
    }
  });
}

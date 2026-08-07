import fs from 'node:fs/promises';
import path from 'node:path';

import type { extensionHandlers } from '../ipc/extensions';
import type { LocalCapabilityPackSource } from '../services/extensions/capability-packs/CapabilityPackLoaderService';
import type {
  CapabilityCommandPromptRequest,
  CapabilityPackExportRequest,
  CapabilityPackImportRequest,
  SkillWatcherEvent,
} from '@shared/types/extensions';
import type { FastifyInstance } from 'fastify';

type ExtensionHandlers = typeof extensionHandlers;

type CapabilityPackRouteHandlers = Pick<
  ExtensionHandlers,
  | 'capabilityPacksList'
  | 'capabilityPacksImport'
  | 'capabilityPacksExport'
  | 'capabilityPacksCommandPrompt'
>;

interface CapabilityPackRouteDependencies {
  handlers: CapabilityPackRouteHandlers;
  localSource: LocalCapabilityPackSource;
  setLocalSource: (source: LocalCapabilityPackSource) => void;
  setSkillsWatcherEmitter: (emit: (event: SkillWatcherEvent) => void) => void;
  broadcastSse: (eventName: string, data: unknown) => void;
}

function sanitizeDownloadFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'download'
  );
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function zipDirectoryForDownload(rootDir: string): Promise<Buffer> {
  const files: { relativePath: string; data: Buffer; mtime: Date }[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      files.push({
        relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
        data: await fs.readFile(fullPath),
        mtime: stat.mtime,
      });
    }
  };
  await visit(rootDir);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const name = Buffer.from(file.relativePath, 'utf8');
    const crc = crc32(file.data);
    const { date, time } = dosDateTime(file.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function registerCapabilityPackRoutes(
  app: FastifyInstance,
  {
    handlers,
    localSource,
    setLocalSource,
    setSkillsWatcherEmitter,
    broadcastSse,
  }: CapabilityPackRouteDependencies
): void {
  setLocalSource(localSource);
  setSkillsWatcherEmitter((event) => broadcastSse('skills:changed', event));

  app.get('/api/extensions/capability-packs', async () => handlers.capabilityPacksList());

  app.post('/api/extensions/capability-packs/import', async (request) =>
    handlers.capabilityPacksImport((request.body ?? {}) as CapabilityPackImportRequest)
  );

  app.post('/api/extensions/capability-packs/export', async (request) =>
    handlers.capabilityPacksExport((request.body ?? {}) as CapabilityPackExportRequest)
  );

  app.post('/api/extensions/capability-packs/export/download', async (request, reply) => {
    const result = (await handlers.capabilityPacksExport(
      (request.body ?? {}) as CapabilityPackExportRequest
    )) as {
      success: boolean;
      data?: { pack?: { packDir?: string; manifest?: { id?: string } }; warnings?: string[] };
      error?: string;
    };
    if (!result.success) {
      return reply
        .code(400)
        .send({ success: false, error: result.error ?? 'Export capability pack failed' });
    }

    const packDir = result.data?.pack?.packDir;
    if (!packDir) {
      return reply
        .code(500)
        .send({ success: false, error: 'Exported capability pack directory is missing' });
    }

    const zip = await zipDirectoryForDownload(packDir);
    const filename = `${sanitizeDownloadFilename(result.data?.pack?.manifest?.id ?? 'capability-pack')}.zip`;
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header(
      'X-Capability-Pack-Warnings',
      encodeURIComponent(JSON.stringify(result.data?.warnings ?? []))
    );
    return reply.send(zip);
  });

  app.post('/api/extensions/capability-packs/command-prompt', async (request) =>
    handlers.capabilityPacksCommandPrompt((request.body ?? {}) as CapabilityCommandPromptRequest)
  );
}

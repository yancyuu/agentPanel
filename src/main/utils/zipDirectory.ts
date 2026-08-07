import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const MAX_FILES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

interface ZipFile {
  relativePath: string;
  data: Buffer;
  mtime: Date;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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

async function collectFiles(rootDir: string): Promise<ZipFile[]> {
  const files: ZipFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES)
        throw new Error(`交付成果超过 ${MAX_FILES} 个文件，无法导出 ZIP`);
      const stat = await fs.stat(fullPath);
      totalBytes += stat.size;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('交付成果超过 100 MB，无法在本地工作台中导出 ZIP');
      }
      files.push({
        relativePath: path.relative(rootDir, fullPath).replaceAll('\\', '/'),
        data: await fs.readFile(fullPath),
        mtime: stat.mtime,
      });
    }
  };
  await visit(rootDir);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Create a portable ZIP without following symlinks or accepting arbitrary paths. */
export async function zipDirectory(rootDir: string): Promise<Buffer> {
  const files = await collectFiles(rootDir);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.relativePath, 'utf8');
    const compressed = deflateRawSync(file.data);
    const shouldCompress = compressed.length < file.data.length;
    const payload = shouldCompress ? compressed : file.data;
    const method = shouldCompress ? 8 : 0;
    const { date, time } = dosDateTime(file.mtime);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
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

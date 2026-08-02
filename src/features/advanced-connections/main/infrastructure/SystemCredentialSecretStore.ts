import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ConnectionSecretStore {
  put(connectionId: string, serializedSecret: string): Promise<void>;
  get(connectionId: string): Promise<string | null>;
  has(connectionId: string): Promise<boolean>;
  delete(connectionId: string): Promise<void>;
}

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

function defaultSecretsDir(): string {
  return path.join(
    process.env.HERMIT_HOME ?? path.join(os.homedir(), '.hermit'),
    'connections',
    'secrets'
  );
}

function assertConnectionId(connectionId: string): void {
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw new Error('连接标识格式无效');
  }
}

/**
 * 连接授权的文件存储（跨平台统一）：`connections/secrets/<connectionId>.json`，
 * 0600 权限 + 原子写（tmp + rename）。取代各平台钥匙串命令——macOS
 * `security add-generic-password` 的 getpass 缓冲区仅 128 字节，会截断
 * ConnectionSecret JSON（通常 300-800 字节），导致读出解析失败、已登录被误判未登录。
 * 旧钥匙串条目不做迁移。
 */
export class SystemCredentialSecretStore implements ConnectionSecretStore {
  constructor(private readonly dir: string = defaultSecretsDir()) {}

  private fileFor(connectionId: string): string {
    assertConnectionId(connectionId);
    return path.join(this.dir, `${connectionId}.json`);
  }

  async put(connectionId: string, serializedSecret: string): Promise<void> {
    const file = this.fileFor(connectionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, serializedSecret, { mode: 0o600 });
      await fs.rename(temporary, file);
      // rename 到既有文件上时权限沿用旧文件，统一收敛到 0600
      await fs.chmod(file, 0o600).catch(() => undefined);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(connectionId: string): Promise<string | null> {
    const file = this.fileFor(connectionId);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      // 损坏内容视为不存在（例如被截断的旧写入）
      return null;
    }
  }

  async has(connectionId: string): Promise<boolean> {
    try {
      await fs.access(this.fileFor(connectionId));
      return true;
    } catch {
      return false;
    }
  }

  async delete(connectionId: string): Promise<void> {
    await fs.rm(this.fileFor(connectionId), { force: true });
  }
}

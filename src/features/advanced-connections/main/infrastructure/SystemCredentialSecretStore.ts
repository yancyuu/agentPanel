import { spawn } from 'node:child_process';

const KEYCHAIN_SERVICE = 'AgentCLI Advanced Connections';

export interface ConnectionSecretStore {
  put(connectionId: string, serializedSecret: string): Promise<void>;
  get(connectionId: string): Promise<string | null>;
  has(connectionId: string): Promise<boolean>;
  delete(connectionId: string): Promise<void>;
}

export interface SecretCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SecretCommandRunner = (
  executable: string,
  args: string[],
  input?: string
) => Promise<SecretCommandResult>;

const defaultRunner: SecretCommandRunner = (executable, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });

export class SystemCredentialSecretStore implements ConnectionSecretStore {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runner: SecretCommandRunner = defaultRunner
  ) {}

  async put(connectionId: string, serializedSecret: string): Promise<void> {
    this.assertSupported();
    // Passing -w as the final option makes `security` read the password twice
    // from stdin, so the secret never appears in argv/process listings.
    const input = `${serializedSecret}\n${serializedSecret}\n`;
    const result = await this.runner(
      '/usr/bin/security',
      ['add-generic-password', '-a', connectionId, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
      input
    );
    if (result.code !== 0) throw new Error('无法将连接授权保存到系统钥匙串');
  }

  async get(connectionId: string): Promise<string | null> {
    if (this.platform !== 'darwin') return null;
    const result = await this.runner('/usr/bin/security', [
      'find-generic-password',
      '-a',
      connectionId,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  async has(connectionId: string): Promise<boolean> {
    if (this.platform !== 'darwin') return false;
    const result = await this.runner('/usr/bin/security', [
      'find-generic-password',
      '-a',
      connectionId,
      '-s',
      KEYCHAIN_SERVICE,
    ]);
    return result.code === 0;
  }

  async delete(connectionId: string): Promise<void> {
    if (this.platform !== 'darwin') return;
    await this.runner('/usr/bin/security', [
      'delete-generic-password',
      '-a',
      connectionId,
      '-s',
      KEYCHAIN_SERVICE,
    ]);
  }

  private assertSupported(): void {
    if (this.platform !== 'darwin') {
      throw new Error('当前系统暂未提供安全凭证存储，无法启用远程登录');
    }
  }
}

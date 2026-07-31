import { spawn } from 'node:child_process';

const KEYCHAIN_SERVICE = 'AgentCLI Advanced Connections';
const WINDOWS_USERNAME = 'agentcli';
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const WINDOWS_VAULT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$operation = $args[0]
$connectionId = $args[1]
$resource = 'AgentCLI Advanced Connections/' + $connectionId
$vault = New-Object Windows.Security.Credentials.PasswordVault
if ($operation -eq 'put') {
  $secret = [Console]::In.ReadToEnd()
  try {
    $existing = $vault.Retrieve($resource, 'agentcli')
    $vault.Remove($existing)
  } catch {}
  $credential = New-Object Windows.Security.Credentials.PasswordCredential($resource, 'agentcli', $secret)
  $vault.Add($credential)
  exit 0
}
if ($operation -eq 'get') {
  try {
    $credential = $vault.Retrieve($resource, 'agentcli')
    $credential.RetrievePassword()
    [Console]::Out.Write($credential.Password)
    exit 0
  } catch { exit 2 }
}
if ($operation -eq 'has') {
  try { $null = $vault.Retrieve($resource, 'agentcli'); exit 0 } catch { exit 2 }
}
if ($operation -eq 'delete') {
  try { $credential = $vault.Retrieve($resource, 'agentcli'); $vault.Remove($credential) } catch {}
  exit 0
}
exit 3
`.trim();

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
    let settled = false;
    const appendBounded = (current: string, chunk: string): string =>
      `${current}${chunk}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    const finish = (result: SecretCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr: 'credential command timed out' });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });

function assertConnectionId(connectionId: string): void {
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw new Error('连接标识格式无效');
  }
}

export class SystemCredentialSecretStore implements ConnectionSecretStore {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runner: SecretCommandRunner = defaultRunner
  ) {}

  async put(connectionId: string, serializedSecret: string): Promise<void> {
    assertConnectionId(connectionId);
    this.assertSupported();
    if (this.platform === 'darwin') {
      // Passing -w as the final option makes `security` read the password twice
      // from stdin, so the secret never appears in argv/process listings.
      const input = `${serializedSecret}\n${serializedSecret}\n`;
      const result = await this.runner(
        '/usr/bin/security',
        ['add-generic-password', '-a', connectionId, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
        input
      );
      if (result.code !== 0) throw new Error('无法将连接授权保存到 macOS 钥匙串');
      return;
    }
    if (this.platform === 'win32') {
      const result = await this.runWindows('put', connectionId, serializedSecret);
      if (result.code !== 0) throw new Error('无法将连接授权保存到 Windows 凭据保管库');
      return;
    }
    const result = await this.runner(
      'secret-tool',
      [
        'store',
        '--label=AgentCLI 高级连接',
        'service',
        KEYCHAIN_SERVICE,
        'connectionId',
        connectionId,
      ],
      serializedSecret
    );
    if (result.code !== 0) {
      throw new Error('无法将连接授权保存到 Linux Secret Service，请确认系统钥匙串已解锁');
    }
  }

  async get(connectionId: string): Promise<string | null> {
    assertConnectionId(connectionId);
    this.assertSupported();
    if (this.platform === 'darwin') {
      const result = await this.runner('/usr/bin/security', [
        'find-generic-password',
        '-a',
        connectionId,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ]);
      return result.code === 0 ? result.stdout.trim() || null : null;
    }
    if (this.platform === 'win32') {
      const result = await this.runWindows('get', connectionId);
      return result.code === 0 ? result.stdout || null : null;
    }
    const result = await this.runner('secret-tool', [
      'lookup',
      'service',
      KEYCHAIN_SERVICE,
      'connectionId',
      connectionId,
    ]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  async has(connectionId: string): Promise<boolean> {
    assertConnectionId(connectionId);
    this.assertSupported();
    if (this.platform === 'darwin') {
      const result = await this.runner('/usr/bin/security', [
        'find-generic-password',
        '-a',
        connectionId,
        '-s',
        KEYCHAIN_SERVICE,
      ]);
      return result.code === 0;
    }
    if (this.platform === 'win32') {
      return (await this.runWindows('has', connectionId)).code === 0;
    }
    const result = await this.runner('secret-tool', [
      'lookup',
      'service',
      KEYCHAIN_SERVICE,
      'connectionId',
      connectionId,
    ]);
    return result.code === 0 && Boolean(result.stdout.trim());
  }

  async delete(connectionId: string): Promise<void> {
    assertConnectionId(connectionId);
    this.assertSupported();
    if (this.platform === 'darwin') {
      await this.runner('/usr/bin/security', [
        'delete-generic-password',
        '-a',
        connectionId,
        '-s',
        KEYCHAIN_SERVICE,
      ]);
      return;
    }
    if (this.platform === 'win32') {
      await this.runWindows('delete', connectionId);
      return;
    }
    await this.runner('secret-tool', [
      'clear',
      'service',
      KEYCHAIN_SERVICE,
      'connectionId',
      connectionId,
    ]);
  }

  private runWindows(
    operation: 'put' | 'get' | 'has' | 'delete',
    connectionId: string,
    input?: string
  ): Promise<SecretCommandResult> {
    return this.runner(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_VAULT_SCRIPT,
        operation,
        connectionId,
        WINDOWS_USERNAME,
      ],
      input
    );
  }

  private assertSupported(): void {
    if (!['darwin', 'win32', 'linux'].includes(this.platform)) {
      throw new Error('当前系统暂未提供安全凭证存储，无法启用远程登录');
    }
  }
}

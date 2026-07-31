import {
  SystemCredentialSecretStore,
  type SecretCommandRunner,
} from '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore';
import { describe, expect, it, vi } from 'vitest';

describe('SystemCredentialSecretStore', () => {
  it('writes macOS Keychain secrets through stdin instead of argv', async () => {
    let capturedArgs: string[] = [];
    let capturedInput: string | undefined;
    const runner: SecretCommandRunner = (_executable, args, input) => {
      capturedArgs = args;
      capturedInput = input;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const store = new SystemCredentialSecretStore('darwin', runner);

    await store.put('connection_1234567890abcdef', '{"accessToken":"secret"}');

    expect(capturedArgs).not.toContain('{"accessToken":"secret"}');
    expect(capturedArgs.at(-1)).toBe('-w');
    expect(capturedInput).toBe('{"accessToken":"secret"}\n{"accessToken":"secret"}\n');
  });

  it('uses Windows PasswordVault without putting the secret in argv', async () => {
    const calls: { executable: string; args: string[]; input?: string }[] = [];
    const runner: SecretCommandRunner = (executable, args, input) => {
      calls.push({ executable, args, input });
      const operation = args.at(-3);
      return Promise.resolve({
        code: 0,
        stdout: operation === 'get' ? '{"accessToken":"secret"}' : '',
        stderr: '',
      });
    };
    const store = new SystemCredentialSecretStore('win32', runner);

    await store.put('connection_1234567890abcdef', '{"accessToken":"secret"}');
    expect(await store.get('connection_1234567890abcdef')).toBe('{"accessToken":"secret"}');
    expect(await store.has('connection_1234567890abcdef')).toBe(true);
    await store.delete('connection_1234567890abcdef');

    expect(calls.every((call) => call.executable === 'powershell.exe')).toBe(true);
    expect(calls[0]?.input).toBe('{"accessToken":"secret"}');
    expect(calls.flatMap((call) => call.args)).not.toContain('{"accessToken":"secret"}');
  });

  it('uses Linux Secret Service with consistent attributes and stdin secrecy', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const runner: SecretCommandRunner = (_executable, args, input) => {
      calls.push({ args, input });
      return Promise.resolve({
        code: 0,
        stdout: args[0] === 'lookup' ? '{"accessToken":"secret"}\n' : '',
        stderr: '',
      });
    };
    const store = new SystemCredentialSecretStore('linux', runner);

    await store.put('connection_1234567890abcdef', '{"accessToken":"secret"}');
    expect(await store.get('connection_1234567890abcdef')).toBe('{"accessToken":"secret"}');
    expect(await store.has('connection_1234567890abcdef')).toBe(true);
    await store.delete('connection_1234567890abcdef');

    expect(calls[0]).toMatchObject({
      args: [
        'store',
        '--label=AgentCLI 高级连接',
        'service',
        'AgentCLI Advanced Connections',
        'connectionId',
        'connection_1234567890abcdef',
      ],
      input: '{"accessToken":"secret"}',
    });
    expect(calls[1]?.args[0]).toBe('lookup');
    expect(calls[3]?.args[0]).toBe('clear');
    expect(calls.flatMap((call) => call.args)).not.toContain('{"accessToken":"secret"}');
  });

  it('fails closed when Linux Secret Service cannot store the credential', async () => {
    const store = new SystemCredentialSecretStore('linux', () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'locked' })
    );
    await expect(store.put('connection_1234567890abcdef', 'secret')).rejects.toThrow(
      'Linux Secret Service'
    );
  });

  it('rejects unsafe connection identifiers before invoking a system command', async () => {
    const runner = vi.fn<SecretCommandRunner>();
    const store = new SystemCredentialSecretStore('darwin', runner);

    await expect(store.put('../unsafe', 'secret')).rejects.toThrow('连接标识格式无效');
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported platforms', async () => {
    const store = new SystemCredentialSecretStore('aix', vi.fn());
    await expect(store.put('connection_1234567890abcdef', 'secret')).rejects.toThrow(
      '暂未提供安全凭证存储'
    );
  });
});

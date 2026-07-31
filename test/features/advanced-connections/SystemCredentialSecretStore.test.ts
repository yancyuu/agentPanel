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

  it('fails closed when a secure system credential store is unavailable', async () => {
    const store = new SystemCredentialSecretStore('linux', vi.fn());
    await expect(store.put('connection_1234567890abcdef', 'secret')).rejects.toThrow(
      '暂未提供安全凭证存储'
    );
  });
});

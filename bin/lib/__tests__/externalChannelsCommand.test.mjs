import { describe, expect, it, vi } from 'vitest';

import { runExternalChannelsCommand } from '../externalChannelsCommand.mjs';

const disabled = {
  ccConnect: { enabled: false, active: false, restartRequired: false, state: 'disabled' },
};

describe('externalChannelsCommand', () => {
  it('reads cc-connect status from the Panel', async () => {
    const client = { request: vi.fn(async () => disabled) };

    await expect(
      runExternalChannelsCommand(['external-channels', 'cc-connect', 'status'], { client })
    ).resolves.toMatchObject({
      ok: true,
      command: 'external-channels cc-connect status',
      ccConnect: disabled.ccConnect,
    });
    expect(client.request).toHaveBeenCalledWith('/api/external-channels');
  });

  it.each([
    ['enable', true],
    ['disable', false],
  ])('persists %s through the Panel lifecycle endpoint', async (action, enabled) => {
    const client = {
      request: vi.fn(async () => ({
        ccConnect: { enabled, active: false, restartRequired: true, state: 'restart-required' },
      })),
    };

    const result = await runExternalChannelsCommand(['external-channels', 'cc-connect', action], {
      client,
    });

    expect(result.ccConnect.restartRequired).toBe(true);
    expect(client.request).toHaveBeenCalledWith('/api/external-channels/cc-connect', {
      method: 'PUT',
      body: { enabled },
    });
  });

  it('rejects unsupported channels and actions before making a request', async () => {
    const client = { request: vi.fn() };

    await expect(
      runExternalChannelsCommand(['external-channels', 'slack', 'status'], { client })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runExternalChannelsCommand(['external-channels', 'cc-connect', 'restart'], { client })
    ).resolves.toMatchObject({ ok: false });
    expect(client.request).not.toHaveBeenCalled();
  });
});

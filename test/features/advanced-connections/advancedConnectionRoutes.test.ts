import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AdvancedConnectionService,
  registerAdvancedConnectionRoutes,
} from '@features/advanced-connections/main';
import type { ConnectionSecretStore } from '@features/advanced-connections/main/infrastructure/SystemCredentialSecretStore';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const emptySecretStore: ConnectionSecretStore = {
  put: () => Promise.resolve(),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  delete: () => Promise.resolve(),
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('advanced connection routes', () => {
  let hermitHome: string;

  beforeEach(async () => {
    hermitHome = await mkdtemp(path.join(os.tmpdir(), 'agentcli-connection-routes-'));
  });

  afterEach(async () => {
    await rm(hermitHome, { recursive: true, force: true });
  });

  it('discovers and creates a renderer-safe compatibility connection', async () => {
    const app = Fastify();
    const service = new AdvancedConnectionService({
      hermitHome,
      fetchImpl: vi.fn((input: string | URL | Request) =>
        Promise.resolve(
          requestUrl(input).endsWith('/api/v1/auth/me')
            ? jsonResponse({}, 401)
            : jsonResponse({}, 404)
        )
      ) as unknown as typeof fetch,
      secretStore: emptySecretStore,
    });
    registerAdvancedConnectionRoutes(app, { service });

    const discover = await app.inject({
      method: 'POST',
      url: '/api/advanced-connections/discover',
      payload: { baseUrl: 'https://bus.company.test' },
    });
    expect(discover.statusCode).toBe(200);
    expect(discover.json()).toMatchObject({
      compatibilityMode: true,
      manifest: { provider: { id: 'openhermit-agentbus' } },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/advanced-connections',
      payload: { baseUrl: 'https://bus.company.test' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.body).not.toContain('access_token');
    expect(create.body).not.toContain('refresh_token');
    expect(create.json()).toMatchObject({ state: 'auth_required', secretPresent: false });

    await app.close();
  });
});

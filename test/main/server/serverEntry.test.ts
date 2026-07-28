import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const startStandaloneServer = vi.fn(() => Promise.resolve(undefined));

vi.mock('../../../src/main/serverStandalone', () => ({
  startStandaloneServer,
}));

describe('server process entry', () => {
  beforeEach(() => {
    startStandaloneServer.mockClear();
  });

  it('does not listen when imported as a module', async () => {
    await import('../../../src/main/server');
    expect(startStandaloneServer).not.toHaveBeenCalled();
  });

  it('keeps server.ts as a thin guarded process entry', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/main/server.ts'), 'utf8');
    expect(source.split('\n').length).toBeLessThanOrEqual(400);
    expect(source).toContain('if (isDirectServerExecution(import.meta.url))');
    expect(source).not.toContain('Fastify(');
  });
});

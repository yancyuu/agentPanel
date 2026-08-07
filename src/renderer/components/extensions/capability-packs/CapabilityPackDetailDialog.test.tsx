import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it } from 'vitest';

import { CapabilityPackDetailDialog } from './CapabilityPackDetailDialog';

import type { LoadedCapabilityPack } from '@shared/types/extensions';

const samplePack: LoadedCapabilityPack = {
  manifest: {
    schemaVersion: 1,
    id: 'local-capabilities-hermit',
    name: 'hermit开发 能力',
    namespace: 'local',
    version: '1.0.0',
    teamName: 'hermit开发',
    capabilities: {
      commands: [
        {
          id: 'c1',
          alias: 'scan',
          title: 'Scan',
          scope: ['team-loop'],
          surfaces: ['slash'],
          safety: 'read-only',
          prompt: 'p.md',
        },
      ],
      skills: [{ id: 's1', name: 'my-skill', path: '/x' }],
      workflows: [{ id: 'w1', name: 'loop-scan', path: 'workflows/x.md' }],
      cron: [
        {
          id: 'j1',
          name: 'daily',
          cronExpression: '0 9 * * *',
          prompt: 'p',
          enabled: true,
          teamName: 'hermit开发',
        },
      ],
      mcpServers: [{ id: 'm1', name: 'ctx', scope: 'local' }],
    },
  },
  packDir: '/tmp',
  source: 'local',
  enabled: true,
  warnings: [],
};

describe('CapabilityPackDetailDialog', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('renders all five capability sections when open', () => {
    act(() => {
      createRoot(container).render(
        <CapabilityPackDetailDialog pack={samplePack} open={true} onClose={() => undefined} />
      );
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('hermit开发 能力');
    expect(text).toContain('Commands');
    expect(text).toContain('Skills');
    expect(text).toContain('Workflows');
    expect(text).toContain('定时任务 (Cron)');
    expect(text).toContain('MCP 服务');
    expect(text).toContain('my-skill');
    expect(text).toContain('loop-scan');
    expect(text).toContain('daily');
  });
});

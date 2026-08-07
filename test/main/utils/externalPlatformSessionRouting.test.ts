import { describe, expect, it } from 'vitest';

import {
  isExternalPlatformSessionKey,
  parseExternalPlatformSessionKey,
  resolveExternalPlatformSessionTeamSlug,
} from '@main/utils/externalPlatformSessionRouting';

import type { TeamManifest } from '@main/services/team-management/TeamWorkspaceService';

function manifest(
  slug: string,
  allow: Pick<TeamManifest, 'platformAllowFrom' | 'platformAllowChat'>
): TeamManifest {
  return {
    schemaVersion: 2,
    slug,
    displayName: slug,
    bindProject: `${slug}-project`,
    harness: 'claudecode',
    workDir: '/tmp/project',
    rootPath: `/tmp/hermit/${slug}`,
    createdAt: new Date(0).toISOString(),
    ...allow,
  };
}

describe('external platform session routing', () => {
  it('detects and parses Feishu/Lark style session keys with union user ids only', () => {
    expect(isExternalPlatformSessionKey('feishu:chat_A:on_user')).toBe(true);
    expect(isExternalPlatformSessionKey('hermit:team:session')).toBe(false);
    expect(parseExternalPlatformSessionKey('feishu:chat_A:on_user')).toEqual({
      platform: 'feishu',
      chatId: 'chat_A',
      userId: 'on_user',
    });
    expect(parseExternalPlatformSessionKey('feishu:chat_A:ou_openid')).toEqual({
      platform: 'feishu',
      chatId: 'chat_A',
      userId: undefined,
    });
  });

  it('maps a Feishu session key to the Hermit team slug using allow_chat/allow_from', () => {
    const teamSlug = resolveExternalPlatformSessionTeamSlug('feishu:chat_A:on_user', [
      manifest('other-team', {
        platformAllowChat: { feishu: 'chat_B' },
        platformAllowFrom: { feishu: '*' },
      }),
      manifest('hermit-team', {
        platformAllowChat: { feishu: 'chat_A' },
        platformAllowFrom: { feishu: 'on_user' },
      }),
    ]);

    expect(teamSlug).toBe('hermit-team');
  });

  it('treats feishu and lark allow-list keys as aliases', () => {
    const teamSlug = resolveExternalPlatformSessionTeamSlug('feishu:chat_A:on_user', [
      manifest('hermit-team', {
        platformAllowChat: { lark: 'chat_A' },
        platformAllowFrom: { lark: 'on_user' },
      }),
    ]);

    expect(teamSlug).toBe('hermit-team');
  });

  it('treats Feishu oc_ and c_ chat IDs as the same allow_chat target', () => {
    const teamSlug = resolveExternalPlatformSessionTeamSlug(
      'feishu:oc_efa2fbf5d5bd75da117eaebb6bbc730d:on_user',
      [
        manifest('hermit-team', {
          platformAllowChat: { feishu: 'c_efa2fbf5d5bd75da117eaebb6bbc730d' },
          platformAllowFrom: { feishu: 'on_user' },
        }),
      ]
    );

    expect(teamSlug).toBe('hermit-team');
  });

  it('routes an 诊断 Feishu session through QR-persisted owner metadata', () => {
    const teamSlug = resolveExternalPlatformSessionTeamSlug('feishu:chat_admin:on_admin', [
      manifest('system-manager', {
        platformAllowFrom: { lark: 'on_admin' },
      }),
    ]);

    expect(teamSlug).toBe('system-manager');
  });

  it('does not guess when multiple teams match equally', () => {
    const teamSlug = resolveExternalPlatformSessionTeamSlug('feishu:chat_A:on_user', [
      manifest('team-a', { platformAllowChat: { feishu: '*' } }),
      manifest('team-b', { platformAllowChat: { feishu: '*' } }),
    ]);

    expect(teamSlug).toBeNull();
  });

  it('returns undefined chatId/userId when the session key omits them', () => {
    expect(parseExternalPlatformSessionKey('feishu:')).toEqual({
      platform: 'feishu',
      chatId: undefined,
      userId: undefined,
    });
    expect(parseExternalPlatformSessionKey('lark:chat_A')).toEqual({
      platform: 'lark',
      chatId: 'chat_A',
      userId: undefined,
    });
  });

  it('returns null for an unknown platform prefix', () => {
    expect(isExternalPlatformSessionKey('unknown:chat:user')).toBe(false);
    expect(parseExternalPlatformSessionKey('unknown:chat:user')).toBeNull();
  });

  it('falls back to bindProject when the winning manifest has no slug', () => {
    const manifestNoSlug = manifest('', {
      platformAllowFrom: { feishu: 'on_user' },
    });
    const bindProject = (manifestNoSlug as TeamManifest).bindProject;
    const teamSlug = resolveExternalPlatformSessionTeamSlug(
      'feishu:chat_A:on_user',
      [manifestNoSlug]
    );

    expect(teamSlug).toBe(bindProject);
  });

  it('resolves to null when no manifests are provided', () => {
    expect(resolveExternalPlatformSessionTeamSlug('feishu:chat_A:on_user', [])).toBeNull();
  });
});

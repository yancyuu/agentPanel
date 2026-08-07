import { describe, expect, it } from 'vitest';

import { isQRPlatform, platformMeta } from '@renderer/components/team/dialogs/platformMeta';

describe('isQRPlatform', () => {
  it('returns true for feishu', () => {
    expect(isQRPlatform('feishu')).toBe(true);
  });

  it('returns true for lark', () => {
    expect(isQRPlatform('lark')).toBe(true);
  });

  it('returns true for weixin', () => {
    expect(isQRPlatform('weixin')).toBe(true);
  });

  it('returns false for telegram', () => {
    expect(isQRPlatform('telegram')).toBe(false);
  });

  it('returns false for discord', () => {
    expect(isQRPlatform('discord')).toBe(false);
  });

  it('returns false for unknown string', () => {
    expect(isQRPlatform('unknown')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isQRPlatform('')).toBe(false);
  });
});

describe('platformMeta data structure', () => {
  const knownPlatforms = Object.keys(platformMeta);

  it('has at least 8 platform entries', () => {
    expect(knownPlatforms.length).toBeGreaterThanOrEqual(8);
  });

  it('every platform has a label', () => {
    for (const key of knownPlatforms) {
      expect(platformMeta[key].label).toBeTruthy();
      expect(typeof platformMeta[key].label).toBe('string');
    }
  });

  it('every platform has at least one field', () => {
    for (const key of knownPlatforms) {
      expect(platformMeta[key].fields.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every field has a key and label', () => {
    for (const key of knownPlatforms) {
      for (const field of platformMeta[key].fields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
      }
    }
  });

  it('type field is valid when present', () => {
    const validTypes = ['text', 'password', 'number', 'boolean'];
    for (const key of knownPlatforms) {
      for (const field of platformMeta[key].fields) {
        if (field.type !== undefined) {
          expect(validTypes).toContain(field.type);
        }
      }
    }
  });

  it('group field is valid when present', () => {
    const validGroups = ['basic', 'advanced'];
    for (const key of knownPlatforms) {
      for (const field of platformMeta[key].fields) {
        if (field.group !== undefined) {
          expect(validGroups).toContain(field.group);
        }
      }
    }
  });

  it('includes telegram, discord, slack, dingtalk platforms', () => {
    expect(knownPlatforms).toContain('telegram');
    expect(knownPlatforms).toContain('discord');
    expect(knownPlatforms).toContain('slack');
    expect(knownPlatforms).toContain('dingtalk');
  });

  it('keeps WeCom websocket and callback metadata separate for concrete modes', () => {
    expect(platformMeta.wecom.label).toBe('企业微信自建应用（Callback）');
    expect(platformMeta.wecom_ws.submitType).toBe('wecom');
    expect(platformMeta.wecom_ws.defaultOptions).toEqual({ mode: 'websocket' });
    expect(platformMeta.wecom_ws.fields.map((field) => field.key)).toEqual([
      'bot_id',
      'bot_secret',
      'allow_from',
    ]);
    expect(platformMeta.wecom.fields.map((field) => field.key)).toContain('corp_id');
    expect(platformMeta.wecom.fields.map((field) => field.key)).not.toContain('bot_id');
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildFeishuLarkAllowUpdatePayload,
  buildPlatformAllowUpdatePayload,
  getFeishuLarkAllowValue,
  getPlatformAllowValue,
  hasFeishuLarkDeleteMarker,
  omitEmptyAllowMap,
  readStringRecord,
  withFeishuLarkAllowValue,
  withPlatformAllowValue,
} from '@renderer/components/team/dialogs/platformAllowUtils';

describe('platformAllowUtils', () => {
  it('reads lark-only values for Feishu/Lark fields', () => {
    expect(getFeishuLarkAllowValue({ lark: 'ou_lark' })).toBe('ou_lark');
  });

  it('preserves unrelated platform keys when updating Feishu/Lark values', () => {
    expect(withFeishuLarkAllowValue({ telegram: '123', lark: 'ou_old' }, 'ou_new')).toEqual({
      telegram: '123',
      lark: 'ou_new',
    });
  });

  it('omits empty maps instead of sending overwrite payloads', () => {
    expect(omitEmptyAllowMap(withFeishuLarkAllowValue({}, ''))).toBeUndefined();
    expect(buildFeishuLarkAllowUpdatePayload({}, '')).toBeUndefined();
  });

  it('emits explicit delete markers when existing Feishu/Lark fields are blanked', () => {
    expect(buildFeishuLarkAllowUpdatePayload({ feishu: 'ou_old' }, '')).toEqual({
      feishu: '',
      lark: '',
    });
    expect(buildFeishuLarkAllowUpdatePayload({ telegram: '123', lark: 'ou_old' }, '')).toEqual({
      telegram: '123',
      feishu: '',
      lark: '',
    });
  });

  it('prefers lark when both Feishu/Lark aliases exist', () => {
    expect(getFeishuLarkAllowValue({ feishu: 'ou_legacy', lark: 'ou_current' })).toBe(
      'ou_current'
    );
    expect(withFeishuLarkAllowValue({ feishu: 'ou_legacy', lark: 'ou_current' }, 'ou_new')).toEqual({
      lark: 'ou_new',
    });
  });

  it('keeps unrelated keys when Feishu/Lark fields are blank', () => {
    expect(withFeishuLarkAllowValue({ telegram: '123', feishu: 'ou_old' }, '')).toEqual({
      telegram: '123',
    });
  });

  it('reads generic platform allow aliases for Feishu/Lark and WeChat/Weixin', () => {
    expect(getPlatformAllowValue({ lark: 'ou_lark' }, 'feishu')).toBe('ou_lark');
    expect(getPlatformAllowValue({ feishu: 'ou_feishu' }, 'lark')).toBe('ou_feishu');
    expect(getPlatformAllowValue({ wechat: 'wx_user' }, 'weixin')).toBe('wx_user');
    expect(getPlatformAllowValue({ weixin: 'wx_user' }, 'wechat')).toBe('wx_user');
  });

  it('updates platform allow aliases without creating duplicate sibling keys', () => {
    expect(withPlatformAllowValue({ telegram: '123', lark: 'old' }, 'feishu', 'new')).toEqual({
      telegram: '123',
      lark: 'new',
    });
    expect(withPlatformAllowValue({ telegram: '123', wechat: 'old' }, 'weixin', '')).toEqual({
      telegram: '123',
    });
    expect(withPlatformAllowValue({ wecom: 'old' }, 'wecom_ws', 'new')).toEqual({
      wecom: 'new',
    });
  });

  it('normalizes string records and drops empty values', () => {
    expect(readStringRecord({ feishu: '  ou_1  ', empty: ' ', bad: 1 })).toEqual({
      feishu: 'ou_1',
    });
  });
});

describe('buildPlatformAllowUpdatePayload', () => {
  it('returns undefined when nothing changed', () => {
    expect(
      buildPlatformAllowUpdatePayload({ feishu: 'ou_1', telegram: '123' }, {
        feishu: 'ou_1',
        telegram: '123',
      })
    ).toBeUndefined();
  });

  it('returns the normalized next map when a value changed', () => {
    expect(
      buildPlatformAllowUpdatePayload({ feishu: 'ou_1' }, { feishu: 'ou_2', telegram: '456' })
    ).toEqual({ feishu: 'ou_2', telegram: '456' });
  });

  it('treats whitespace-only and empty entries as a change from a populated value', () => {
    // readStringRecord drops empty entries, so the normalized next map loses
    // the key while the source kept it — that counts as a change.
    expect(buildPlatformAllowUpdatePayload({ feishu: 'ou_1' }, { feishu: '   ' })).toEqual({});
  });

  it('returns undefined when both base and values are empty', () => {
    expect(buildPlatformAllowUpdatePayload({}, {})).toBeUndefined();
  });
});

describe('hasFeishuLarkDeleteMarker', () => {
  it('detects a blank feishu entry', () => {
    expect(hasFeishuLarkDeleteMarker({ feishu: '' })).toBe(true);
    expect(hasFeishuLarkDeleteMarker({ feishu: '   ' })).toBe(true);
  });

  it('detects a blank lark entry', () => {
    expect(hasFeishuLarkDeleteMarker({ lark: '' })).toBe(true);
  });

  it('returns false when feishu/lark entries hold real values', () => {
    expect(hasFeishuLarkDeleteMarker({ feishu: 'ou_1', lark: 'ou_2' })).toBe(false);
  });

  it('returns false for non-feishu/lark keys regardless of value', () => {
    expect(hasFeishuLarkDeleteMarker({ telegram: '' })).toBe(false);
    expect(hasFeishuLarkDeleteMarker({ weixin: '' })).toBe(false);
  });

  it('returns false for non-object or array inputs', () => {
    expect(hasFeishuLarkDeleteMarker(null)).toBe(false);
    expect(hasFeishuLarkDeleteMarker(undefined)).toBe(false);
    expect(hasFeishuLarkDeleteMarker(['feishu'])).toBe(false);
    expect(hasFeishuLarkDeleteMarker('feishu')).toBe(false);
  });

  it('ignores whitespace-padded feishu/lark keys', () => {
    // Keys are trimmed before matching the feishu/lark set.
    expect(hasFeishuLarkDeleteMarker({ '  feishu ': '' })).toBe(true);
  });
});

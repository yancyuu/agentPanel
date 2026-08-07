import { describe, expect, it } from 'vitest';

/**
 * Sanitize team name: keep Unicode letters and digits (Chinese, Latin, etc.),
 * replace other sequences with `-`, then lowercase Latin chars.
 */
function sanitizeTeamName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

describe('sanitizeTeamName', () => {
  it('preserves Chinese characters', () => {
    expect(sanitizeTeamName('产品助手')).toBe('产品助手');
  });

  it('preserves numeric names', () => {
    expect(sanitizeTeamName('1121')).toBe('1121');
  });

  it('preserves mixed Chinese and Latin', () => {
    expect(sanitizeTeamName('中文English混合')).toBe('中文english混合');
  });

  it('replaces special chars with hyphens', () => {
    expect(sanitizeTeamName('Product Team!')).toBe('product-team');
  });

  it('replaces spaces with hyphens', () => {
    expect(sanitizeTeamName('前端 工程师')).toBe('前端-工程师');
  });

  it('trims whitespace', () => {
    expect(sanitizeTeamName('  产品助手  ')).toBe('产品助手');
  });

  it('replaces @ and # with hyphens', () => {
    expect(sanitizeTeamName('test@123')).toBe('test-123');
    expect(sanitizeTeamName('My Team #1')).toBe('my-team-1');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeTeamName('')).toBe('');
    expect(sanitizeTeamName('   ')).toBe('');
  });

  it('does NOT produce fallback team-hash for Chinese input', () => {
    // Old behavior: Chinese-only input was stripped to empty, then fallback to "team-{hash}"
    // New behavior: Chinese characters are preserved
    const result = sanitizeTeamName('测试团队');
    expect(result).toBe('测试团队');
    expect(result).not.toMatch(/^team-/);
  });

  it('handles Korean characters', () => {
    expect(sanitizeTeamName('팀이름')).toBe('팀이름');
  });

  it('handles Japanese characters', () => {
    expect(sanitizeTeamName('チーム名')).toBe('チーム名');
  });

  it('handles emoji-free mixed input with punctuation', () => {
    expect(sanitizeTeamName('AI/ML-助手（新版）')).toBe('ai-ml-助手-新版');
  });
});

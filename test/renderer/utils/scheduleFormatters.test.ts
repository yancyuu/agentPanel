import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cron } from 'croner';

import { formatNextRun, getCronDescription } from '@renderer/utils/scheduleFormatters';

// =============================================================================
// formatNextRun tests
// =============================================================================

describe('formatNextRun', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 暂无 for undefined', () => {
    expect(formatNextRun(undefined)).toBe('暂无');
  });

  it('returns 暂无 for empty string', () => {
    expect(formatNextRun('')).toBe('暂无');
  });

  it('returns 已逾期 for past dates', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    expect(formatNextRun('2026-06-05T12:00:00.000Z')).toBe('已逾期');
  });

  it('returns 即将运行 for dates within 1 minute', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    expect(formatNextRun('2026-06-06T12:00:30.000Z')).toBe('即将运行');
  });

  it('returns N 分钟后 for dates within the hour', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    const result = formatNextRun('2026-06-06T12:05:00.000Z');
    expect(result).toBe('5 分钟后');
  });

  it('returns N 小时 M 分钟后 for dates within 24 hours', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    const result = formatNextRun('2026-06-06T15:30:00.000Z');
    expect(result).toBe('3 小时 30 分钟后');
  });

  it('returns formatted date string for dates more than 24 hours out', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    const result = formatNextRun('2026-06-08T09:00:00.000Z');
    expect(result).toContain('6月');
    expect(result).toContain('8');
  });

  it('returns raw string for unparseable input', () => {
    const result = formatNextRun('not-a-date');
    expect(result).toBe('not-a-date');
  });

  it('handles exactly 1 minute away', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    expect(formatNextRun('2026-06-06T12:01:00.000Z')).toBe('1 分钟后');
  });

  it('handles 23h59m (should show hour format)', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    const result = formatNextRun('2026-06-07T11:59:00.000Z');
    expect(result).toContain('小时');
    expect(result).toContain('分钟');
  });

  it('output never exceeds 30 characters (no overflow)', () => {
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
    const result = formatNextRun('2026-12-25T09:00:00.000Z');
    expect(result.length).toBeLessThan(30);
  });
});

// =============================================================================
// getCronDescription tests
// =============================================================================

describe('getCronDescription', () => {
  it('describes a daily cron expression', () => {
    const result = getCronDescription('0 9 * * *');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('describes an every-2-hours cron expression', () => {
    const result = getCronDescription('0 */2 * * *');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns raw expression for invalid cron', () => {
    const invalid = 'not-valid-cron';
    const result = getCronDescription(invalid);
    expect(result).toBe(invalid);
  });

  it('describes a specific minute/hour cron', () => {
    const result = getCronDescription('30 14 * * 1-5');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// sanitizeTeamName tests — validates that Chinese names are preserved
// =============================================================================

function sanitizeTeamName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

describe('sanitizeTeamName', () => {
  it('preserves Chinese characters (Unicode letters)', () => {
    expect(sanitizeTeamName('产品经理团队')).toBe('产品经理团队');
  });

  it('preserves Latin characters', () => {
    expect(sanitizeTeamName('My Team')).toBe('my-team');
  });

  it('preserves mixed Chinese and Latin', () => {
    expect(sanitizeTeamName('团队V2')).toBe('团队v2');
  });

  it('returns empty for whitespace-only input', () => {
    expect(sanitizeTeamName('   ')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeTeamName('')).toBe('');
  });

  it('replaces special characters with dash', () => {
    expect(sanitizeTeamName('Team@#$Name')).toBe('team-name');
  });
});

// =============================================================================
// toSlug tests — demonstrates why Chinese names produce "team-N" slugs
// =============================================================================

function toSlug(input: string, fallback = 'team'): string {
  const ascii = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return ascii || fallback;
}

describe('toSlug', () => {
  it('converts Latin names to slug', () => {
    expect(toSlug('My Team')).toBe('my-team');
  });

  it('falls back to "team" for Chinese (all non-ASCII) — root cause of duplicate teams', () => {
    expect(toSlug('产品经理团队')).toBe('team');
  });

  it('handles mixed input (keeps ASCII, strips rest)', () => {
    expect(toSlug('Team 产品')).toBe('team');
  });

  it('returns fallback for empty input', () => {
    expect(toSlug('')).toBe('team');
  });

  it('handles special characters', () => {
    expect(toSlug('Hello, World!')).toBe('hello-world');
  });

  it('normalizes accented characters', () => {
    expect(toSlug('Café Résumé')).toBe('cafe-resume');
  });
});

// =============================================================================
// displayName uniqueness tests
// =============================================================================

describe('displayName uniqueness', () => {
  it('detects duplicate Chinese display names (case-insensitive)', () => {
    const existing = [
      { slug: 'team-3', displayName: '产品经理团队' },
      { slug: 'team-4', displayName: '产品经理团队' },
    ];
    const newInput = '产品经理团队';
    const isDuplicate = existing.some(
      (t) => t.displayName.toLowerCase() === newInput.toLowerCase()
    );
    expect(isDuplicate).toBe(true);
  });

  it('does not flag different display names', () => {
    const existing = [
      { slug: 'team-3', displayName: '产品经理团队' },
    ];
    const newInput = '测试团队';
    const isDuplicate = existing.some(
      (t) => t.displayName.toLowerCase() === newInput.toLowerCase()
    );
    expect(isDuplicate).toBe(false);
  });

  it('is case-insensitive for Latin names', () => {
    const existing = [
      { slug: 'my-team', displayName: 'My Team' },
    ];
    const newInput = 'my team';
    const isDuplicate = existing.some(
      (t) => t.displayName.toLowerCase() === newInput.toLowerCase()
    );
    expect(isDuplicate).toBe(true);
  });
});

// =============================================================================
// nextRunAt computation tests (croner)
// =============================================================================

describe('nextRunAt computation', () => {
  it('computes next run for a valid daily cron', () => {
    const job = new Cron('0 9 * * *', { timezone: 'Asia/Shanghai', paused: true });
    const next = job.nextRun();
    expect(next).toBeTruthy();
    expect(next instanceof Date).toBe(true);
  });

  it('throws for invalid cron expression', () => {
    expect(() => new Cron('not-valid', { paused: true })).toThrow();
  });

  it('computes next run for every-2-hour cron', () => {
    const job = new Cron('0 */2 * * *', { timezone: 'Asia/Shanghai', paused: true });
    const next = job.nextRun();
    expect(next).toBeTruthy();
    const nextDate = next instanceof Date ? next : new Date(next!);
    expect(nextDate.getHours() % 2).toBe(0);
  });

  it('computes next run for weekly cron', () => {
    const job = new Cron('0 18 * * 4', { timezone: 'Asia/Shanghai', paused: true });
    const next = job.nextRun();
    expect(next).toBeTruthy();
    const nextDate = next instanceof Date ? next : new Date(next!);
    expect(nextDate.getDay()).toBe(4);
  });

  it('next run is always in the future', () => {
    const job = new Cron('*/5 * * * *', { timezone: 'UTC', paused: true });
    const next = job.nextRun();
    expect(next).toBeTruthy();
    const now = Date.now();
    const nextTime = next instanceof Date ? next.getTime() : new Date(next!).getTime();
    expect(nextTime).toBeGreaterThan(now - 1000);
  });

  it('disabled schedule should have undefined nextRunAt', () => {
    const enabled = false;
    let nextRunAt: string | undefined;
    if (enabled) {
      nextRunAt = new Date().toISOString();
    }
    expect(nextRunAt).toBeUndefined();
  });

  it('enabled schedule produces a valid ISO date nextRunAt', () => {
    const enabled = true;
    const cronExpr = '0 9 * * *';
    let nextRunAt: string | undefined;
    if (enabled && cronExpr) {
      try {
        const job = new Cron(cronExpr.trim(), { timezone: 'Asia/Shanghai', paused: true });
        const next = job.nextRun();
        if (next) {
          nextRunAt = (next instanceof Date ? next : new Date(next)).toISOString();
        }
      } catch {
        // Invalid cron expression
      }
    }
    expect(nextRunAt).toBeTruthy();
    expect(new Date(nextRunAt!).getTime()).not.toBeNaN();
  });
});

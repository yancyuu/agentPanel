import { describe, expect, it } from 'vitest';

import { generateBindProject, isValidBindProject } from '../bindProjectSlug';

describe('isValidBindProject', () => {
  it('accepts lowercase ascii slugs', () => {
    expect(isValidBindProject('team-1')).toBe(true);
    expect(isValidBindProject('frontend_bot')).toBe(true);
    expect(isValidBindProject('a')).toBe(true);
  });

  it('rejects empty / uppercase / leading hyphen / spaces', () => {
    expect(isValidBindProject('')).toBe(false);
    expect(isValidBindProject('Team')).toBe(false);
    expect(isValidBindProject('-x')).toBe(false);
    expect(isValidBindProject('has space')).toBe(false);
  });
});

describe('generateBindProject', () => {
  it('returns empty for blank input', () => {
    expect(generateBindProject('   ', new Set())).toBe('');
  });

  it('slugifies ascii names', () => {
    expect(generateBindProject('Front End', new Set())).toMatch(/^front-end-[0-9a-z]+$/);
  });

  it('falls back to a team- base for non-ascii names', () => {
    expect(generateBindProject('产品助手', new Set())).toMatch(/^team-[0-9a-z]+$/);
  });

  it('is deterministic for the same input + existing set (no per-keystroke reshuffle)', () => {
    const existing = new Set<string>();
    const a = generateBindProject('产品助手', existing);
    const b = generateBindProject('产品助手', existing);
    // The identifier must not reshuffle on every render/keystroke — this is the
    // root cause of the flickering "already exists" red box.
    expect(a).toBe(b);
  });

  it('never collides with existing bind projects (no false "已存在")', () => {
    // Simulate a prior worker that already took the deterministic id.
    const taken = generateBindProject('产品助手', new Set());
    const existing = new Set([taken]);
    const next = generateBindProject('产品助手', existing);
    expect(existing.has(next)).toBe(false);
    expect(isValidBindProject(next)).toBe(true);
  });

  it('keeps producing non-colliding ids across many creations', () => {
    const existing = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const id = generateBindProject('产品助手', existing);
      expect(existing.has(id)).toBe(false);
      expect(isValidBindProject(id)).toBe(true);
      existing.add(id);
    }
    expect(existing.size).toBe(20);
  });

  it('produces a valid identifier for varied inputs', () => {
    for (const name of ['前端工程师', 'My Cool Bot', '运维-巡检', '']) {
      const id = generateBindProject(name, new Set());
      // Empty name is allowed to yield '' (the dialog treats blank as "not set").
      if (id) expect(isValidBindProject(id)).toBe(true);
    }
  });
});

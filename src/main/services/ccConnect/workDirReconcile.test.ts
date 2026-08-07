import { describe, expect, it } from 'vitest';

import {
  CC_CONNECT_PLACEHOLDER_WORK_DIR,
  isPlaceholderWorkDir,
  needsWorkDirReconcile,
} from './workDirReconcile';

describe('needsWorkDirReconcile', () => {
  it('reconciles when the project still carries the default template placeholder', () => {
    // The system-manager bind project ('my-project') collides with cc-connect's
    // default template, whose work_dir is the never-filled placeholder. The agent
    // spawn then fails with `chdir /path/to/your/project: no such file or directory`.
    expect(needsWorkDirReconcile(CC_CONNECT_PLACEHOLDER_WORK_DIR, '/Users/me/code/hermit')).toBe(
      true
    );
  });

  it('does not reconcile when the work_dir already matches the manifest', () => {
    expect(needsWorkDirReconcile('/Users/me/code/hermit', '/Users/me/code/hermit')).toBe(false);
  });

  it('reconciles when the work_dir drifted to a different real path', () => {
    expect(needsWorkDirReconcile('/old/path', '/new/path')).toBe(true);
  });

  it('does not reconcile when there is no expected work_dir to enforce', () => {
    // Never overwrite a project's work_dir with an empty value — that would clear
    // a valid path rather than repair a bad one.
    expect(needsWorkDirReconcile('/Users/me/code/hermit', '')).toBe(false);
    expect(needsWorkDirReconcile('/Users/me/code/hermit', undefined)).toBe(false);
    expect(needsWorkDirReconcile('/Users/me/code/hermit', '   ')).toBe(false);
  });

  it('reconciles when the project has no work_dir yet but a manifest dir exists', () => {
    expect(needsWorkDirReconcile(undefined, '/Users/me/code/hermit')).toBe(true);
    expect(needsWorkDirReconcile('', '/Users/me/code/hermit')).toBe(true);
    expect(needsWorkDirReconcile(null, '/Users/me/code/hermit')).toBe(true);
  });

  it('treats whitespace-only differences as equal after trimming', () => {
    expect(needsWorkDirReconcile('  /Users/me/code/hermit  ', '/Users/me/code/hermit')).toBe(false);
  });
});

describe('isPlaceholderWorkDir', () => {
  it('recognizes the cc-connect default template placeholder', () => {
    expect(isPlaceholderWorkDir(CC_CONNECT_PLACEHOLDER_WORK_DIR)).toBe(true);
    expect(isPlaceholderWorkDir('  /path/to/your/project  ')).toBe(true);
  });

  it('returns false for real or empty work_dirs', () => {
    expect(isPlaceholderWorkDir('/Users/me/code/hermit')).toBe(false);
    expect(isPlaceholderWorkDir('')).toBe(false);
    expect(isPlaceholderWorkDir(undefined)).toBe(false);
  });
});

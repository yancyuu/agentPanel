import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectCliSessionStore } from './DirectCliSessionStore';

describe('DirectCliSessionStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'direct-cli-store-'));
    filePath = path.join(tmpDir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown keys on a fresh store (no file)', () => {
    const store = new DirectCliSessionStore(filePath);
    expect(store.get('team-x:lead')).toBeUndefined();
    expect(store.has('team-x:lead')).toBe(false);
  });

  it('persists a session id and reads it back within the same instance', () => {
    const store = new DirectCliSessionStore(filePath);
    store.set('team-x:lead', 'claude-sid-1');
    expect(store.get('team-x:lead')).toBe('claude-sid-1');
    expect(store.has('team-x:lead')).toBe(true);
  });

  it('survives across instances — round-trips through the JSON file', () => {
    new DirectCliSessionStore(filePath).set('team-x:lead', 'claude-sid-1');
    new DirectCliSessionStore(filePath).set('team-x:member:爬虫', 'claude-sid-2');

    const reopened = new DirectCliSessionStore(filePath);
    expect(reopened.get('team-x:lead')).toBe('claude-sid-1');
    expect(reopened.get('team-x:member:爬虫')).toBe('claude-sid-2');
    expect(reopened.has('team-x:lead')).toBe(true);

    // File is valid JSON we can read directly.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(onDisk).toEqual({
      'team-x:lead': 'claude-sid-1',
      'team-x:member:爬虫': 'claude-sid-2',
    });
  });

  it('deletes a key and removes it from the file', () => {
    const store = new DirectCliSessionStore(filePath);
    store.set('team-x:lead', 'claude-sid-1');
    store.delete('team-x:lead');
    expect(store.get('team-x:lead')).toBeUndefined();
    expect(store.has('team-x:lead')).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({});
  });

  it('ignores empty / whitespace-only keys or session ids', () => {
    const store = new DirectCliSessionStore(filePath);
    store.set('', 'sid');
    store.set('   ', 'sid');
    store.set('team-x:lead', '   ');
    store.set('team-y:lead', '');
    expect(store.all()).toEqual({});
  });

  it('recovers from a corrupt sessions.json instead of throwing', () => {
    writeFileSync(filePath, '{ not valid json', 'utf-8');
    const store = new DirectCliSessionStore(filePath);
    expect(store.get('anything')).toBeUndefined();
    // A subsequent set should rewrite a clean file.
    store.set('team-x:lead', 'sid-after-corruption');
    expect(store.get('team-x:lead')).toBe('sid-after-corruption');
    expect(() => JSON.parse(readFileSync(filePath, 'utf-8'))).not.toThrow();
  });
});

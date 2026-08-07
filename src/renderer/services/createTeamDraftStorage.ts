/**
 * Atomic draft storage for CreateTeamDialog form snapshots.
 *
 * Stores the form state (team name, paths, color) under a single IndexedDB
 * key so navigating away from the Teams tab and back preserves user input.
 * No TTL — drafts persist until explicitly cleared on successful team creation.
 *
 * Pattern mirrors `composerDraftStorage.ts`.
 */

import { del, get, set } from 'idb-keyval';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Current snapshot schema version. Bump when shape changes.
 *
 * v2 (2026-05-22): dropped `members`, `syncModelsWithLead`,
 * `teammateWorktreeDefault`, `soloTeam`, `launchTeam` — workspace-scoped
 * teams have no upfront roster and always auto-launch.
 */
const SNAPSHOT_VERSION = 2;

export interface CreateTeamDraftSnapshot {
  version: number;
  teamName: string;
  cwdMode: 'project' | 'custom';
  selectedProjectPath: string;
  customCwd: string;
  teamColor: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'createTeamDraft:form';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidSnapshot(data: unknown): data is CreateTeamDraftSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.version === 'number' &&
    obj.version === SNAPSHOT_VERSION &&
    typeof obj.teamName === 'string' &&
    (obj.cwdMode === 'project' || obj.cwdMode === 'custom') &&
    typeof obj.selectedProjectPath === 'string' &&
    typeof obj.customCwd === 'string' &&
    typeof obj.teamColor === 'string' &&
    typeof obj.updatedAt === 'number'
  );
}

// ---------------------------------------------------------------------------
// IDB availability tracking
// ---------------------------------------------------------------------------

let idbUnavailable = false;
let idbUnavailableLogged = false;
const fallbackStore = new Map<string, CreateTeamDraftSnapshot>();

function markIdbUnavailable(): void {
  if (!idbUnavailableLogged) {
    idbUnavailableLogged = true;
    console.warn(
      '[createTeamDraftStorage] IndexedDB unavailable, using in-memory storage for this session.'
    );
  }
  idbUnavailable = true;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

async function saveSnapshot(snapshot: CreateTeamDraftSnapshot): Promise<void> {
  if (idbUnavailable) {
    fallbackStore.set(STORAGE_KEY, snapshot);
    return;
  }
  try {
    await set(STORAGE_KEY, snapshot);
  } catch {
    markIdbUnavailable();
    fallbackStore.set(STORAGE_KEY, snapshot);
  }
}

async function loadSnapshot(): Promise<CreateTeamDraftSnapshot | null> {
  if (idbUnavailable) {
    return fallbackStore.get(STORAGE_KEY) ?? null;
  }
  try {
    const data = await get<unknown>(STORAGE_KEY);
    if (data == null) return null;
    if (isValidSnapshot(data)) return data;
    // Invalid shape (including older versions) — discard silently
    void del(STORAGE_KEY);
    return null;
  } catch {
    markIdbUnavailable();
    return fallbackStore.get(STORAGE_KEY) ?? null;
  }
}

async function deleteSnapshot(): Promise<void> {
  if (idbUnavailable) {
    fallbackStore.delete(STORAGE_KEY);
    return;
  }
  try {
    await del(STORAGE_KEY);
  } catch {
    markIdbUnavailable();
    fallbackStore.delete(STORAGE_KEY);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function emptySnapshot(): CreateTeamDraftSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    teamName: '',
    cwdMode: 'project',
    selectedProjectPath: '',
    customCwd: '',
    teamColor: '',
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const createTeamDraftStorage = {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  emptySnapshot,
};

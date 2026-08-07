/**
 * Unified draft hook for CreateTeamDialog form state.
 *
 * Persists team name, paths, and color to IndexedDB so navigating away from
 * the Teams tab and back preserves user input.
 *
 * Key guarantees:
 * - Single IndexedDB key (`createTeamDraft:form`), no TTL.
 * - Race-safe: late async load never overwrites fresh user input.
 * - Debounced writes with immediate flush on unmount.
 * - Draft is cleared only on successful team creation.
 *
 * Pattern mirrors `useComposerDraft.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CreateTeamDraftSnapshot,
  createTeamDraftStorage,
} from '@renderer/services/createTeamDraftStorage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCreateTeamDraftResult {
  teamName: string;
  setTeamName: (v: string) => void;
  cwdMode: 'project' | 'custom';
  setCwdMode: (v: 'project' | 'custom') => void;
  selectedProjectPath: string;
  setSelectedProjectPath: (v: string) => void;
  customCwd: string;
  setCustomCwd: (v: string) => void;
  teamColor: string;
  setTeamColor: (v: string) => void;

  /** `true` after the initial IndexedDB load completes. */
  isLoaded: boolean;
  /** Clear all draft state and delete the IndexedDB entry. */
  clearDraft: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 400;
const SNAPSHOT_VERSION = 2;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreateTeamDraft(): UseCreateTeamDraftResult {
  // ── State ──────────────────────────────────────────────────────────────
  const [teamName, setTeamNameState] = useState('');
  const [cwdMode, setCwdModeState] = useState<'project' | 'custom'>('project');
  const [selectedProjectPath, setSelectedProjectPathState] = useState('');
  const [customCwd, setCustomCwdState] = useState('');
  const [teamColor, setTeamColorState] = useState('');
  const [isLoaded, setIsLoaded] = useState(false);

  // ── Refs (latest values for debounced callbacks) ───────────────────────
  const teamNameRef = useRef('');
  const cwdModeRef = useRef<'project' | 'custom'>('project');
  const selectedProjectPathRef = useRef('');
  const customCwdRef = useRef('');
  const teamColorRef = useRef('');
  const mountedRef = useRef(true);
  const userTouchedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<CreateTeamDraftSnapshot | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Snapshot builder ───────────────────────────────────────────────────

  const buildSnapshot = useCallback((): CreateTeamDraftSnapshot => {
    return {
      version: SNAPSHOT_VERSION,
      teamName: teamNameRef.current,
      cwdMode: cwdModeRef.current,
      selectedProjectPath: selectedProjectPathRef.current,
      customCwd: customCwdRef.current,
      teamColor: teamColorRef.current,
      updatedAt: Date.now(),
    };
  }, []);

  // ── Flush / schedule ───────────────────────────────────────────────────

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      const isEmpty = pending.teamName === '';
      if (isEmpty) {
        void createTeamDraftStorage.deleteSnapshot();
      } else {
        void createTeamDraftStorage.saveSnapshot(pending);
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    const snapshot = buildSnapshot();
    pendingRef.current = snapshot;

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      const isEmpty = pending.teamName === '';
      if (isEmpty) {
        void createTeamDraftStorage.deleteSnapshot();
      } else {
        void createTeamDraftStorage.saveSnapshot(pending);
      }
    }, DEBOUNCE_MS);
  }, [buildSnapshot]);

  // ── Apply snapshot to state ────────────────────────────────────────────

  const applySnapshot = useCallback((snap: CreateTeamDraftSnapshot) => {
    teamNameRef.current = snap.teamName;
    cwdModeRef.current = snap.cwdMode;
    selectedProjectPathRef.current = snap.selectedProjectPath;
    customCwdRef.current = snap.customCwd;
    teamColorRef.current = snap.teamColor;

    setTeamNameState(snap.teamName);
    setCwdModeState(snap.cwdMode);
    setSelectedProjectPathState(snap.selectedProjectPath);
    setCustomCwdState(snap.customCwd);
    setTeamColorState(snap.teamColor);
  }, []);

  // ── Load on mount ──────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const snapshot = await createTeamDraftStorage.loadSnapshot();
      if (cancelled) return;

      // Race protection: if user already interacted, don't overwrite
      if (userTouchedRef.current) {
        if (mountedRef.current) setIsLoaded(true);
        return;
      }

      if (snapshot != null) {
        applySnapshot(snapshot);
      }

      if (mountedRef.current) setIsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  // ── Setters ────────────────────────────────────────────────────────────

  const setTeamName = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      teamNameRef.current = v;
      setTeamNameState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setCwdMode = useCallback(
    (v: 'project' | 'custom') => {
      userTouchedRef.current = true;
      cwdModeRef.current = v;
      setCwdModeState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setSelectedProjectPath = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      selectedProjectPathRef.current = v;
      setSelectedProjectPathState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setCustomCwd = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      customCwdRef.current = v;
      setCustomCwdState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setTeamColor = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      teamColorRef.current = v;
      setTeamColorState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  // ── Clear all ──────────────────────────────────────────────────────────

  const clearDraft = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    userTouchedRef.current = true;

    teamNameRef.current = '';
    cwdModeRef.current = 'project';
    selectedProjectPathRef.current = '';
    customCwdRef.current = '';
    teamColorRef.current = '';

    setTeamNameState('');
    setCwdModeState('project');
    setSelectedProjectPathState('');
    setCustomCwdState('');
    setTeamColorState('');

    void createTeamDraftStorage.deleteSnapshot();
  }, []);

  return {
    teamName,
    setTeamName,
    cwdMode,
    setCwdMode,
    selectedProjectPath,
    setSelectedProjectPath,
    customCwd,
    setCustomCwd,
    teamColor,
    setTeamColor,
    isLoaded,
    clearDraft,
  };
}

import React, { useEffect, useMemo } from 'react';

import { TooltipProvider } from '@renderer/components/ui/tooltip';

import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ContextSwitchOverlay } from './components/common/ContextSwitchOverlay';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { TabbedLayout } from './components/layout/TabbedLayout';
import { RuntimeReadinessBanner } from './components/runtime/RuntimeReadinessBanner';
import { type SplashSceneHandle, startSplashScene } from './components/splash/splashScene';
import { ToolApprovalSheet } from './components/team/ToolApprovalSheet';
import { useTheme } from './hooks/useTheme';
import { api } from './api';
import { useStore } from './store';

import type { PaneLayout } from './types/panes';
import type { Tab } from './types/tabs';

const PERSIST_KEY = 'hermit:lastTeam';
const DEFAULT_APP_PATH = '/inbox';

function getActiveTabFromLayout(activeTabId: string | null, paneLayout: PaneLayout): Tab | null {
  if (!activeTabId) return null;
  for (const pane of paneLayout.panes) {
    const tab = pane.tabs.find((item) => item.id === activeTabId);
    if (tab) return tab;
  }
  return null;
}

function buildPathForTab(activeTab: Tab | null): string {
  if (!activeTab) {
    return DEFAULT_APP_PATH;
  }
  switch (activeTab.type) {
    case 'team':
      if (activeTab.teamName === 'system-manager') return '/system-manager';
      return activeTab.teamName
        ? `/team/${encodeURIComponent(activeTab.teamName)}`
        : DEFAULT_APP_PATH;
    case 'teams':
      return '/teams';
    case 'settings':
      return '/settings';
    case 'extensions':
      return '/extensions';
    case 'schedules':
      return '/schedules';
    case 'inbox':
      return '/inbox';
    case 'tasks':
      return '/tasks';
    case 'collaboration':
      return '/collaboration';
    case 'dashboard':
      return '/dashboard';
    case 'session': {
      if (!activeTab.projectId || !activeTab.sessionId) return DEFAULT_APP_PATH;
      return `/session/${encodeURIComponent(activeTab.projectId)}/${encodeURIComponent(activeTab.sessionId)}`;
    }
    case 'notifications':
      return '/notifications';
    case 'graph':
      return activeTab.teamName ? `/graph/${encodeURIComponent(activeTab.teamName)}` : '/graph';
    case 'report':
      return activeTab.projectId && activeTab.sessionId
        ? `/report/${encodeURIComponent(activeTab.projectId)}/${encodeURIComponent(activeTab.sessionId)}`
        : '/report';
    default:
      return DEFAULT_APP_PATH;
  }
}

function useTeamPersistence(): void {
  // Keep the last selected team for explicit team navigation. The root route
  // now belongs to the inbox, so this value must never auto-open a team and
  // pull users away from their attention queue.
  // Save team when it changes
  useEffect(() => {
    const unsub = useStore.subscribe((state, prevState) => {
      if (state.selectedTeamName !== prevState.selectedTeamName && state.selectedTeamName) {
        try {
          localStorage.setItem(PERSIST_KEY, state.selectedTeamName);
        } catch {
          /* ignore */
        }
      }
    });
    return unsub;
  }, []);
}

function useTabPathPersistence(): void {
  const { activeTabId, paneLayout } = useStore((s) => ({
    activeTabId: s.activeTabId,
    paneLayout: s.paneLayout,
  }));

  const activeTab = useMemo(
    () => getActiveTabFromLayout(activeTabId, paneLayout),
    [activeTabId, paneLayout]
  );

  // The initial route is restored before first render (main.tsx →
  // restoreInitialRoute), so this hook only keeps the URL in sync as the active
  // tab changes. No post-mount restore, no routeReady gate.
  useEffect(() => {
    const nextPath = buildPathForTab(activeTab);
    if (window.location.pathname === nextPath) return;
    window.history.replaceState(null, '', nextPath);
  }, [activeTab]);
}

declare global {
  interface Window {
    __claudeTeamsSplashEnhancedStartedAt?: number;
    __claudeTeamsSplashScene?: SplashSceneHandle;
    __claudeTeamsSplashStartedAt?: number;
  }
}

const SPLASH_MIN_DURATION_MS = 2800;
const SPLASH_ENHANCED_HOLD_MS = 800;
const SPLASH_FADE_MS = 480;
const SPLASH_ROUTE_RESTORE_FADE_MS = 120;
const SPLASH_REDUCED_MIN_DURATION_MS = 600;
const SPLASH_REDUCED_HOLD_MS = 200;
const SPLASH_REDUCED_FADE_MS = 180;
const SPLASH_AVATAR_READY_MAX_WAIT_MS = 900;
const SPLASH_REDUCED_AVATAR_READY_MAX_WAIT_MS = 160;

export const App = (): React.JSX.Element => {
  // Initialize theme on app load
  useTheme();

  // Persist the last explicitly selected team without changing the inbox landing route.
  useTeamPersistence();
  // Keep URL path in sync with active tab and restore from URL.
  useTabPathPersistence();

  // Upgrade the static preload splash, then dismiss it after the scene is visible.
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const scene = window.__claudeTeamsSplashScene ?? startSplashScene(splash, { reducedMotion });
      const startedAt = window.__claudeTeamsSplashStartedAt ?? performance.now();
      const enhancedStartedAt = window.__claudeTeamsSplashEnhancedStartedAt ?? performance.now();
      const elapsed = performance.now() - startedAt;
      const enhancedElapsed = performance.now() - enhancedStartedAt;
      const routeRestored = window.location.pathname !== '/' && window.location.pathname !== '';
      const minDuration = routeRestored
        ? 0
        : reducedMotion
          ? SPLASH_REDUCED_MIN_DURATION_MS
          : SPLASH_MIN_DURATION_MS;
      const enhancedHold = routeRestored
        ? 0
        : reducedMotion
          ? SPLASH_REDUCED_HOLD_MS
          : SPLASH_ENHANCED_HOLD_MS;
      const fadeDuration = routeRestored
        ? SPLASH_ROUTE_RESTORE_FADE_MS
        : reducedMotion
          ? SPLASH_REDUCED_FADE_MS
          : SPLASH_FADE_MS;
      const avatarReadyMaxWait = reducedMotion
        ? SPLASH_REDUCED_AVATAR_READY_MAX_WAIT_MS
        : SPLASH_AVATAR_READY_MAX_WAIT_MS;
      const exitDelay = Math.max(minDuration - elapsed, enhancedHold - enhancedElapsed, 0);
      let removeTimer: number | undefined;
      let avatarReadyTimer: number | undefined;
      let dismissed = false;

      const dismissSplash = (): void => {
        if (dismissed) return;
        dismissed = true;
        splash.classList.add('splash-exiting');
        removeTimer = window.setTimeout(() => {
          scene.stop();
          window.__claudeTeamsSplashScene = undefined;
          window.__claudeTeamsSplashEnhancedStartedAt = undefined;
          splash.remove();
        }, fadeDuration);
      };

      const exitTimer = window.setTimeout(() => {
        avatarReadyTimer = window.setTimeout(dismissSplash, avatarReadyMaxWait);
        void (scene.ready ?? Promise.resolve()).then(dismissSplash, dismissSplash);
      }, exitDelay);

      return () => {
        dismissed = true;
        window.clearTimeout(exitTimer);
        if (avatarReadyTimer !== undefined) {
          window.clearTimeout(avatarReadyTimer);
        }
        if (removeTimer !== undefined) {
          window.clearTimeout(removeTimer);
        }
      };
    }

    return undefined;
  }, []);

  // Initialize context system lazily when SSH connection state changes.
  // Local-only users never pay the cost of IndexedDB init + context IPC calls.
  useEffect(() => {
    if (!api.ssh?.onStatus) return;
    const cleanup = api.ssh.onStatus(() => {
      void useStore.getState().initializeContextSystem();
      void useStore.getState().fetchAvailableContexts();
    });
    return cleanup;
  }, []);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150} skipDelayDuration={1500}>
        <ContextSwitchOverlay />
        <RuntimeReadinessBanner />
        <TabbedLayout />
        <ConfirmDialog />
        <ToolApprovalSheet />
      </TooltipProvider>
    </ErrorBoundary>
  );
};

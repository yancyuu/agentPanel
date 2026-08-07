import './index.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { restoreInitialRoute } from './utils/initialRoute';
import { App } from './App';
import { initSentryRenderer } from './sentry';
import { initializeNotificationListeners, useStore } from './store';

declare global {
  interface Window {
    __claudeTeamsUiDidInit?: boolean;
  }
}

// Sentry must be initialised before React renders.
initSentryRenderer();

if (!window.__claudeTeamsUiDidInit) {
  window.__claudeTeamsUiDidInit = true;
  initializeNotificationListeners();
}

// Restore the URL route into the store BEFORE first render so the initial paint
// already shows the correct tab. This closes the first-load blank-content race
// (e.g. /teams rendering empty until a post-mount effect opened the tab).
restoreInitialRoute(useStore.getState(), window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

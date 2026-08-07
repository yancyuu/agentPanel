/**
 * splashScene — Terminal-style loading splash.
 *
 * Replaces the heavy canvas robot animation with a clean,
 * Yume-inspired terminal boot sequence.
 */

export interface SplashSceneHandle {
  stop: () => void;
  ready?: Promise<void>;
}

export interface SplashSceneOptions {
  reducedMotion?: boolean;
}

declare global {
  interface Window {
    __claudeTeamsSplashEnhancedStartedAt?: number;
    __claudeTeamsSplashScene?: SplashSceneHandle;
  }
}

// Version is injected at build time from package.json (vite.web.config.ts define),
// the same source the Settings page and Sentry use — so the splash version always
// tracks the real release instead of a stale hardcoded literal.
const BOOT_LINES = [
  `🦀 hermit v${__APP_VERSION__}`,
  'connecting harness…',
  'loading team configs…',
  'scanning session history…',
  'indexing project files…',
  'ready.',
];

export function startSplashScene(
  splash: HTMLElement,
  options: SplashSceneOptions = {}
): SplashSceneHandle {
  const existingScene = window.__claudeTeamsSplashScene;
  if (existingScene && splash.querySelector('#splash-terminal')) {
    return existingScene;
  }

  const reducedMotion =
    options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Remove old canvas if present
  splash.querySelector('#splash-enhanced-canvas')?.remove();

  // Hide the original HTML splash content (logo, text, tagline)
  const splashCopy = splash.querySelector('#splash-copy');
  if (splashCopy instanceof HTMLElement) {
    splashCopy.style.display = 'none';
  }

  const container = document.createElement('div');
  container.id = 'splash-terminal';
  container.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.8;
    color: rgba(148, 163, 184, 0.8);
    padding: 24px;
    opacity: 0;
    z-index: 5;
    animation: splash-term-in 0.4s ease-out 0.1s forwards;
  `;

  // Boot lines appear one by one
  const linesContainer = document.createElement('div');
  linesContainer.style.cssText = 'text-align: left; width: 100%; max-width: 320px;';
  container.appendChild(linesContainer);

  // Cursor
  const cursor = document.createElement('span');
  cursor.textContent = '█';
  cursor.style.cssText = reducedMotion
    ? 'opacity: 0.6;'
    : 'animation: splash-cursor-blink 1s step-end infinite;';
  cursor.setAttribute('aria-hidden', 'true');

  splash.appendChild(container);

  let running = true;
  let lineIndex = 0;

  function addNextLine(): void {
    if (!running || lineIndex >= BOOT_LINES.length) return;

    const line = BOOT_LINES[lineIndex];
    if (!line) return;

    const lineEl = document.createElement('div');
    lineEl.style.cssText =
      'opacity: 0; transform: translateY(4px); transition: opacity 0.3s, transform 0.3s;';

    if (lineIndex === 0) {
      // First line — brand with crab
      const brand = document.createElement('span');
      brand.textContent = '> ';
      brand.style.color = 'rgba(148, 163, 184, 0.4)';
      lineEl.appendChild(brand);

      const cmd = document.createElement('span');
      cmd.textContent = line;
      cmd.style.color = 'rgba(226, 232, 240, 0.9)';
      cmd.style.fontWeight = '500';
      lineEl.appendChild(cmd);
    } else if (line === 'ready.') {
      const ready = document.createElement('span');
      ready.textContent = '✓ ';
      ready.style.color = 'rgba(52, 211, 153, 0.7)';
      lineEl.appendChild(ready);

      const text = document.createElement('span');
      text.textContent = line;
      text.style.color = 'rgba(52, 211, 153, 0.6)';
      lineEl.appendChild(text);
    } else {
      const arrow = document.createElement('span');
      arrow.textContent = '  ';
      lineEl.appendChild(arrow);

      const text = document.createElement('span');
      text.textContent = line;
      lineEl.appendChild(text);
    }

    linesContainer.appendChild(lineEl);

    // Animate in
    requestAnimationFrame(() => {
      lineEl.style.opacity = '1';
      lineEl.style.transform = 'translateY(0)';
    });

    lineIndex++;

    if (lineIndex < BOOT_LINES.length) {
      setTimeout(addNextLine, reducedMotion ? 80 : 280);
    } else {
      // Append cursor after last line
      const lastLine = linesContainer.lastElementChild;
      if (lastLine) {
        lastLine.appendChild(cursor);
      }
    }
  }

  // Start boot sequence after a brief delay
  setTimeout(addNextLine, reducedMotion ? 50 : 120);

  const handle: SplashSceneHandle = {
    stop: () => {
      running = false;
      container.remove();
      if (window.__claudeTeamsSplashScene === handle) {
        window.__claudeTeamsSplashScene = undefined;
        window.__claudeTeamsSplashEnhancedStartedAt = undefined;
      }
    },
  };
  window.__claudeTeamsSplashScene = handle;
  window.__claudeTeamsSplashEnhancedStartedAt = performance.now();

  return handle;
}

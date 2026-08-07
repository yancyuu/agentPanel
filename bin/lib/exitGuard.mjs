// exitGuard.mjs — Windows-only workaround for a Node 24 libuv abort.
//
// Node 24 on Windows: calling process.exit() while undici still holds an idle
// keep-alive connection aborts the process with "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)" (src/win/async.c). Any CLI command
// that did 2+ fetches in one session and then exits hits it — auth login,
// usage, update, … (natural event-loop exit is unaffected; ≤50ms delayed exit
// still crashes, ≥75ms is reliable).
//
// Workaround: process.exit becomes a sentinel THROW so no further user code
// runs (a plain delayed exit would let post-exit prints corrupt --json output
// and let the flat hermit.mjs script fall through into later stages), and the
// real exit happens 100ms later once libuv has settled the handles. Command
// wrappers whose own try/catch would swallow the sentinel must call
// rethrowIfExitSentinel(err) first in their catch block.
//
// Non-Windows platforms are untouched.

const EXIT_SENTINEL = Symbol('agentpanel-process-exit');

let installed = false;
let scheduled = false;
let realExit = null;

const EXIT_DELAY_MS = (() => {
  const raw = Number.parseInt(process.env.AGENTPANEL_EXIT_DELAY_MS ?? '', 10);
  // 100ms suffices for the bare-fetch repro but the full CLI flow (multiple
  // fetches + spawned browser opener + file writes) still crashed below 300ms.
  return Number.isFinite(raw) && raw >= 0 ? raw : 300;
})();

function scheduleRealExit(code) {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => realExit(typeof code === 'number' ? code : 0), EXIT_DELAY_MS);
}

export function isExitSentinel(err) {
  return Boolean(err && typeof err === 'object' && err[EXIT_SENTINEL]);
}

/** Call first in catch blocks that wrap printJson/process.exit call sites. */
export function rethrowIfExitSentinel(err) {
  if (isExitSentinel(err)) throw err;
}

export function installProcessExitGuard() {
  if (installed || process.platform !== 'win32') return;
  installed = true;
  realExit = process.exit.bind(process);

  process.exit = (code = 0) => {
    const sentinel = new Error(`agentpanel process.exit(${code})`);
    sentinel[EXIT_SENTINEL] = true;
    sentinel.exitCode = code;
    throw sentinel;
  };

  const handle = (err) => {
    if (isExitSentinel(err)) return scheduleRealExit(err.exitCode);
    console.error(err);
    scheduleRealExit(1);
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}

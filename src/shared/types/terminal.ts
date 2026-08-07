/**
 * Terminal types — shared between main, preload, and renderer processes.
 *
 * Commands open in the system/default terminal.
 */

// =============================================================================
// Preload API
// =============================================================================

/**
 * Terminal API exposed via preload bridge.
 */
export interface TerminalAPI {
  /** Open command in the system terminal. */
  openExternal: (options: { command: string; args?: string[]; cwd?: string }) => Promise<void>;
}

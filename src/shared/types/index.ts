/**
 * Shared type definitions.
 *
 * @main/types 提供 Session / Chunk / Process / ParsedMessage 等核心类型,
 * @shared/types/* 下还包括 notifications / visualization 等。
 *
 * Usage:
 *   import type { Session } from '@shared/types';
 */

// Re-export all types from main process types
export * from '@main/types';

// Re-export notification and config types
export * from './notifications';

// Re-export visualization types (WaterfallData, WaterfallItem)
export type * from './visualization';

// Re-export API types (ElectronAPI, ConfigAPI, etc.)
export type * from './api';

// Re-export shared IPC result shape
export type * from './ipc';

// Re-export Team Management types
export type * from './team';

// Re-export Schedule types
export type * from './schedule';

// Re-export Review types (Phase 1)
export type * from './review';

// Re-export CLI Installer types
export type * from './cliInstaller';

// Re-export Provider types (global AI model channels)
export type * from './providers';

// Re-export Terminal types
export type * from './terminal';

// Re-export System Manager types
export type * from './systemManager';

// Re-export Worker types
export type * from './worker';

// Re-export Loop Assets types
export type * from './loopAssets';

// Re-export Editor types
export type * from './editor';

// Re-export Extension Store types (inferCapabilities is re-exported from extensionNormalizers)
export type * from './extensions';

// Re-export RuntimeReadiness types (cc-connect health for the degraded banner)
export type * from './runtimeReadiness';

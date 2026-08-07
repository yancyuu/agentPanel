export type LoopAssetCategoryKey = 'automations' | 'worktrees' | 'skills' | 'subagents' | 'state';

export type LoopAssetStatus = 'ready' | 'partial' | 'missing' | 'warning';

export type LoopAssetLifecycle = 'ready' | 'active' | 'missing-assets' | 'stale' | 'unknown';

export interface LoopAssetAction {
  id: string;
  label: string;
  kind:
    | 'navigate'
    | 'open-dialog'
    | 'open-file'
    | 'run-workflow'
    | 'copy-command'
    | 'loop-session'
    | 'run-command';
  target?: string;
  payload?: Record<string, unknown>;
  disabled?: boolean;
  tooltip?: string;
}

export interface LoopAssetSourceRef {
  label: string;
  path?: string;
  scope: 'project' | 'team' | 'user' | 'system' | 'external';
  kind?: string;
}

export interface LoopAssetCategorySnapshot {
  key: LoopAssetCategoryKey;
  title: string;
  subtitle: string;
  status: LoopAssetStatus;
  count: number;
  details: string[];
  gap: string;
  sources: LoopAssetSourceRef[];
  actions: LoopAssetAction[];
  warnings?: string[];
}

export interface LoopAssetsSnapshot {
  teamName: string;
  displayName?: string;
  bindProject?: string;
  workDir: string;
  lifecycle: LoopAssetLifecycle;
  healthScore: number;
  scannedAt: string;
  categories: LoopAssetCategorySnapshot[];
  warnings?: string[];
}

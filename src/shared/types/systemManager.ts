export interface SystemDiagnosticRun {
  id: string;
  actionId: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
  sessionKey: string;
  messageId: string;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export type CleanupCandidateCategory =
  | 'application-temp'
  | 'old-logs'
  | 'project-cache'
  | 'system-junk';

export interface CleanupCandidate {
  id: string;
  category: CleanupCandidateCategory;
  categoryLabel: string;
  name: string;
  path: string;
  displayPath: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  itemCount: number;
  modifiedAt: string;
  reason: string;
  selectedByDefault: true;
}

export interface CleanupScanResult {
  scannedAt: string;
  candidates: CleanupCandidate[];
  totalBytes: number;
  totalItems: number;
  scannedWorkspaces: number;
  warnings: string[];
}

export interface CleanupExecutionResult {
  cleanedAt: string;
  removedIds: string[];
  failed: { id: string; error: string }[];
  freedBytes: number;
  remaining: CleanupScanResult;
}

export interface SystemManagerStatus {
  displayName: '诊断';
  /** Canonical runtime path for the admin loop (~/.hermit). */
  adminWorkDir: string;
  defaultWorkDir: string;
  selectedWorkDir: string;
  claudeCommand: 'claude';
  localStatus: 'ready' | 'missing-claude' | 'error';
  error?: string;
}

export interface SystemManagerConfig {
  schemaVersion: 1;
  selectedWorkDir: string;
  /** One-shot marker: the ops-guide bootstrap has been fed into the admin lead session. */
  adminInitialized?: boolean;
  updatedAt: string;
}

export interface SystemManagerConfigPatch {
  selectedWorkDir?: string;
  adminInitialized?: boolean;
}

export type WorkflowPromptSource = 'claude-command';

export type WorkflowPromptSafety =
  | 'read-only'
  | 'reporting'
  | 'audit'
  | 'proposal-only'
  | 'apply'
  | 'destructive'
  | 'unknown';

export interface WorkflowPromptSummary {
  id: string;
  label: string;
  filename: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
  folder?: string;
  source?: WorkflowPromptSource;
  commandName?: string;
  description?: string;
  category?: string;
  safety?: WorkflowPromptSafety;
  builtin?: boolean;
  order?: number;
}

export interface WorkflowPromptListResponse {
  folder: string;
  prompts: WorkflowPromptSummary[];
  warnings: string[];
}

export interface WorkflowPromptContentResponse {
  prompt: WorkflowPromptSummary;
  content: string;
}

export interface SystemManagerAPI {
  getStatus: () => Promise<SystemManagerStatus>;
  getConfig: () => Promise<SystemManagerConfig>;
  updateConfig: (patch: SystemManagerConfigPatch) => Promise<SystemManagerConfig>;
  listWorkflowPrompts: (folder: string) => Promise<WorkflowPromptListResponse>;
  readWorkflowPrompt: (folder: string, id: string) => Promise<WorkflowPromptContentResponse>;
}

export type CollaborationRunPhase =
  | 'roundtable'
  | 'electing'
  | 'planning'
  | 'executing'
  | 'integrating'
  | 'review'
  | 'completed'
  | 'failed';

export interface CollaborationTeam {
  schemaVersion: 1;
  slug: string;
  displayName: string;
  description?: string;
  memberTeamSlugs: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CollaborationMemberSnapshot {
  teamSlug: string;
  displayName: string;
  description?: string;
  harness: string;
  workDir: string;
}

export interface RoundtableBallot {
  memberTeamSlug: string;
  memberDisplayName: string;
  nomineeTeamSlug: string;
  statement: string;
  suggestedContribution: string;
  receivedAt: string;
}

export type CollaborationWorkItemStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed';

export interface CollaborationWorkItem {
  id: string;
  title: string;
  description: string;
  assigneeTeamSlug: string;
  assigneeDisplayName: string;
  expectedOutput: string;
  taskId?: string;
  status: CollaborationWorkItemStatus;
  result?: string;
  error?: string;
  updatedAt: string;
}

export interface CollaborationRunInputFile {
  filename: string;
  mimeType: string;
  size: number;
  pathsByMember: Record<string, string>;
}

export interface CollaborationRun {
  schemaVersion: 1;
  id: string;
  collaborationTeamSlug: string;
  collaborationTeamDisplayName: string;
  title: string;
  description?: string;
  phase: CollaborationRunPhase;
  members: CollaborationMemberSnapshot[];
  inputFiles?: CollaborationRunInputFile[];
  ballots: RoundtableBallot[];
  captainTeamSlug?: string;
  captainDisplayName?: string;
  rootTaskId?: string;
  rootTaskTeamSlug?: string;
  workItems: CollaborationWorkItem[];
  finalResult?: string;
  revisionFeedback?: string;
  revisionNumber?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollaborationTeamRequest {
  displayName: string;
  description?: string;
  memberTeamSlugs: string[];
}

export interface CreateCollaborationRunRequest {
  title: string;
  description?: string;
  attachments?: {
    filename: string;
    mimeType: string;
    base64Data: string;
  }[];
}

export interface CollaborationTeamDetail {
  team: CollaborationTeam;
  members: CollaborationMemberSnapshot[];
  runs: CollaborationRun[];
}

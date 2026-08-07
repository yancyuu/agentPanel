export const GITHUB_DELIVERY_ROUTES = {
  bindings: '/api/github-delivery/bindings',
  publish: '/api/github-delivery/publish',
} as const;

export type GitHubDeliveryTransport = 'https' | 'ssh';

export interface GitHubDeliveryBinding {
  agentName: string;
  repository: string;
  branch: string;
  /** The user-selected, credential-free Git transport. */
  transport: GitHubDeliveryTransport;
  updatedAt: string;
}

export interface SaveGitHubDeliveryBindingRequest {
  repository: string;
  branch?: string;
  transport?: GitHubDeliveryTransport;
}

export interface PublishGitHubDeliveryRequest {
  teamName: string;
  taskId: string;
  agentName: string;
}

export interface GitHubDeliveryReceipt {
  repository: string;
  branch: string;
  path: string;
  commit: string;
  url: string | null;
  publishedAt: string;
}

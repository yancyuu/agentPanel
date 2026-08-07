/**
 * Hermit team workspace + provisioning services (v2).
 *
 * 设计：一个 Team = 一个 cc-connect project，无 Member 子层级。
 * - TeamWorkspaceService: 本地目录管理（team.json / messages / tasks/board.json）
 * - TeamProvisioningService: 组合 cc-connect
 */

export {
  buildHermitOpsRunbookContext,
  buildMemberWorkflowWithOpsContext,
  HERMIT_OPS_GUIDE_URL,
  removeHermitOpsRunbookContext,
} from './OpsRunbookContext';
export { TeamProvisioningService } from './TeamProvisioningService';
export type {
  AppendGroupMessageInput,
  CreateTeamInput,
  GroupMessage,
  Task,
  TaskStatus,
  TeamManifest,
} from './TeamWorkspaceService';
export {
  groupSessionKey,
  teamRoot,
  teamsRoot,
  TeamWorkspaceService,
  toSlug,
} from './TeamWorkspaceService';

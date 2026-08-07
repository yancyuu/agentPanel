/**
 * @deprecated Use ../hermitBridge for new code.
 */
export { HermitBridgeClient as CcConnectClient } from '../hermitBridge/HermitBridgeClient';
export type { HermitBridgeConnectionEvents as CcConnectBridgeEvents } from '../hermitBridge/HermitBridgeConnection';
export { HermitBridgeConnection as CcConnectBridge } from '../hermitBridge/HermitBridgeConnection';
export type {
  BridgeCommand,
  BridgeLaunchOptions,
  BridgeManagementProbe,
  EnsureRunningOptions,
  EnsureRunningResult,
  ResolveBinaryFn,
  SpawnedBridge,
  SpawnFn,
} from '../hermitBridge/HermitBridgeLauncher';
export { HermitBridgeLauncher as CcConnectLauncher } from '../hermitBridge/HermitBridgeLauncher';
export { MessageBridge } from '../hermitBridge/MessageBridge';
export {
  buildHermitBridgeProjectName as buildCcProjectName,
  ProjectMappingStore,
} from '../hermitBridge/ProjectMappingStore';
export {
  HERMIT_BRIDGE_PLACEHOLDER_WORK_DIR as CC_CONNECT_PLACEHOLDER_WORK_DIR,
  isPlaceholderWorkDir,
  needsWorkDirReconcile,
} from '../hermitBridge/workDirReconcile';

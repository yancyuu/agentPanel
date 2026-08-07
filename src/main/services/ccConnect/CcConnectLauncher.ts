/**
 * @deprecated Use ../hermitBridge/HermitBridgeLauncher for new code.
 */
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
export {
  buildBridgeArgs,
  HermitBridgeLauncher as CcConnectLauncher,
  resolveBridgeCommand,
  resolveHermitBridgeBinaryName,
} from '../hermitBridge/HermitBridgeLauncher';

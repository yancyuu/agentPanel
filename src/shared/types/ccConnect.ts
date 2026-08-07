/**
 * @deprecated Use @shared/types/hermitBridge for new code.
 *
 * Compatibility exports for older Hermit code that still imports the bridge
 * protocol types through the historical ccConnect module name.
 */

export type {
  HermitBridgeAddPlatformRequest as CcAddPlatformRequest,
  HermitBridgeAgentType as CcAgentType,
  HermitBridgeApiResponse as CcApiResponse,
  HermitBridgeButtonsMessage as CcBridgeButtonsMessage,
  HermitBridgeCardActionMessage as CcBridgeCardActionMessage,
  HermitBridgeCardMessage as CcBridgeCardMessage,
  HermitBridgeIncomingMessage as CcBridgeIncomingMessage,
  HermitBridgeOutgoingMessage as CcBridgeOutgoingMessage,
  HermitBridgePingMessage as CcBridgePingMessage,
  HermitBridgePongMessage as CcBridgePongMessage,
  HermitBridgeRegisterMessage as CcBridgeRegisterMessage,
  HermitBridgeReplyMessage as CcBridgeReplyMessage,
  HermitBridgeReplyStreamMessage as CcBridgeReplyStreamMessage,
  HermitBridgeTokenUsage as CcBridgeTokenUsage,
  HermitBridgeTypingMessage as CcBridgeTypingMessage,
  HermitBridgeUsageMessage as CcBridgeUsageMessage,
  HermitBridgeUserMessage as CcBridgeUserMessage,
  HermitBridgeConnectionConfig as CcConnectConfig,
  HermitBridgeCreateCronJobRequest as CcCreateCronJobRequest,
  HermitBridgeCronJob as CcCronJob,
  HermitBridgeGlobalProvider as CcGlobalProvider,
  HermitBridgeHeartbeatStatus as CcHeartbeatStatus,
  HermitBridgeModelEntry as CcModelEntry,
  HermitBridgeProjectDetail as CcProjectDetail,
  HermitBridgeProjectHeartbeat as CcProjectHeartbeat,
  HermitBridgeProjectListItem as CcProjectListItem,
  HermitBridgeProjectMapping as CcProjectMapping,
  HermitBridgeProjectPlatform as CcProjectPlatform,
  HermitBridgeProjectSettings as CcProjectSettings,
  HermitBridgeProjectSettingsUpdate as CcProjectSettingsUpdate,
  HermitBridgeProviderModelEntry as CcProviderModelEntry,
  HermitBridgeProviderPreset as CcProviderPreset,
  HermitBridgeProviderPresetAgentConfig as CcProviderPresetAgentConfig,
  HermitBridgeProviderPresetsResponse as CcProviderPresetsResponse,
  HermitBridgeSessionDetail as CcSessionDetail,
  HermitBridgeSessionListItem as CcSessionListItem,
  HermitBridgeSessionMessage as CcSessionMessage,
  HermitBridgeStatus as CcStatus,
} from './hermitBridge';
export { HERMIT_BRIDGE_DEFAULTS as CC_CONNECT_DEFAULTS } from './hermitBridge';

/**
 * Shared harness type definitions used across the app.
 * Mirrors cc-connect's HermitBridgeAgentType.
 */

import assistantCreationOptions from '@shared/assistantCreationOptions.json';

import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

export type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

export const ALL_AGENT_TYPES: HermitBridgeAgentType[] = assistantCreationOptions.agentTypes.map(
  (option) => option.key as HermitBridgeAgentType
);

export const AGENT_TYPE_LABELS: Record<HermitBridgeAgentType, string> = Object.fromEntries(
  assistantCreationOptions.agentTypes.map((option) => [option.key, option.label])
) as Record<HermitBridgeAgentType, string>;

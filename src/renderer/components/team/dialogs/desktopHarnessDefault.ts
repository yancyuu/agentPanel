import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

export interface HarnessAvailabilitySnapshot {
  type: string;
  available: boolean;
  bundled?: boolean;
  desktopManaged?: boolean;
}

export function selectDesktopDefaultHarness(
  snapshots: readonly HarnessAvailabilitySnapshot[]
): HermitBridgeAgentType | null {
  if (!snapshots.some((snapshot) => snapshot.desktopManaged)) return null;
  const available = new Set(
    snapshots.filter((snapshot) => snapshot.available).map((snapshot) => snapshot.type)
  );
  if (available.has('claudecode')) return 'claudecode';
  if (available.has('codex')) return 'codex';
  const pi = snapshots.find((snapshot) => snapshot.type === 'pi');
  if (pi?.available || pi?.bundled) return 'pi';
  return null;
}

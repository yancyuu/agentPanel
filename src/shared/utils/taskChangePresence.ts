import type { TaskChangePresenceState, TaskChangeSetV2 } from '../types';

const EMPTY_INTERVAL_NO_EDITS_WARNING = 'No file edits found within persisted workIntervals.';

type TaskChangePresenceResult = Partial<
  Pick<TaskChangeSetV2, 'files' | 'confidence' | 'warnings' | 'scope'>
>;

function isBenignActiveIntervalWithoutFileEdits(data: TaskChangePresenceResult): boolean {
  const files = Array.isArray(data.files) ? data.files : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const scope = data.scope;

  if (files.length > 0) {
    return false;
  }

  if (warnings.length !== 1 || warnings[0] !== EMPTY_INTERVAL_NO_EDITS_WARNING) {
    return false;
  }

  return (
    Boolean(scope?.startTimestamp) &&
    !scope?.endTimestamp &&
    Array.isArray(scope?.toolUseIds) &&
    scope.toolUseIds.length === 0
  );
}

export function resolveTaskChangePresenceFromResult(
  data: TaskChangePresenceResult
): Exclude<TaskChangePresenceState, 'unknown'> | null {
  if (!Array.isArray(data.files)) {
    return null;
  }

  if (data.files.length > 0) {
    return 'has_changes';
  }

  if (isBenignActiveIntervalWithoutFileEdits(data)) {
    return null;
  }

  if ((Array.isArray(data.warnings) ? data.warnings.length : 0) > 0) {
    return 'needs_attention';
  }

  return data.confidence === 'high' || data.confidence === 'medium' ? 'no_changes' : null;
}

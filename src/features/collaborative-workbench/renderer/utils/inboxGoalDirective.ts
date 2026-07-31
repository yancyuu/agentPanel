const GOAL_DIRECTIVE_PATTERN = /^\/goal(?:\s+|$)/i;

export function hasInboxGoalDirective(text: string): boolean {
  return GOAL_DIRECTIVE_PATTERN.test(text.trimStart());
}

export function ensureInboxGoalDirective(text: string): string {
  const normalized = text.trim();
  if (!normalized || hasInboxGoalDirective(normalized)) return normalized;
  return `/goal ${normalized}`;
}

export function stripInboxGoalDirective(text: string): string {
  const normalized = text.trimStart();
  if (!hasInboxGoalDirective(normalized)) return text;
  return normalized.replace(GOAL_DIRECTIVE_PATTERN, '').trimStart();
}

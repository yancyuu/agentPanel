/**
 * Project-identifier (bindProject) generation for the create-digital-worker
 * dialog. Extracted from CreateTeamDialog so the slug rules can be unit-tested.
 */

/** Validate bindProject: ASCII lowercase alphanumeric, hyphens, underscores. */
export function isValidBindProject(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

/** Reduce a display name to an ASCII slug base (empty when there's no ASCII). */
function slugBase(displayName: string): string {
  return displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Deterministic 4-char suffix derived from the name. Replaces the old
 * `Math.random()` suffix so the identifier stops reshuffling on every keystroke
 * — same name (+ same collision context) always yields the same candidate.
 */
function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 4).padStart(4, '0');
}

/**
 * Generate a unique ASCII project identifier from a display name.
 *
 * The result is deterministic for a given (name, existing) pair and is
 * guaranteed NOT to collide with any id in `existing`. Together those two
 * properties kill the old flickering false-"已存在" red box: the auto-generated
 * identifier is stable while typing and is never flagged as a duplicate.
 */
export function generateBindProject(displayName: string, existing: ReadonlySet<string>): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '';
  const base = slugBase(trimmed) || 'team';

  // Primary candidate: base + deterministic suffix.
  const candidate = `${base}-${hashSuffix(trimmed)}`;
  if (!existing.has(candidate)) return candidate;

  // Collision (another worker already took the deterministic id): walk a numeric
  // counter until we find a free slot. Bounded by existing size + 2.
  let counter = 2;
  while (existing.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

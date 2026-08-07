/**
 * Parses a leading "@team subject" directive from a message body.
 *
 * Accepts both the ASCII '@' (U+0040) and the full-width '＠' (U+FF20) so a
 * mention typed under a CJK IME still routes cross-team. Without this, a
 * full-width '＠' fails the dispatch regex, the message falls through to a
 * local send, and the user's own team answers instead of the mentioned one.
 *
 * Only the trigger character is normalized here; case / slug resolution is left
 * to each caller (MessageComposer vs loopSendIntent), which already differ.
 *
 * `\s` already covers the full-width space (U+3000), so no special separator
 * handling is needed.
 */
const TEAM_MENTION_DIRECTIVE_RE = /^[@＠]([^\s]+)\s+([\s\S]+)$/;

export interface TeamMentionDirective {
  /** Token after the trigger, up to the first whitespace (team slug or display name). */
  mentioned: string;
  /** Everything after the separating whitespace, trimmed. */
  subject: string;
}

export function parseTeamMentionDirective(text: string): TeamMentionDirective | null {
  const match = TEAM_MENTION_DIRECTIVE_RE.exec(text);
  if (!match) return null;
  const mentioned = match[1];
  const subject = match[2]?.trim();
  if (!mentioned || !subject) return null;
  return { mentioned, subject };
}

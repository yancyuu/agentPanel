/**
 * Message-id generation for direct-CLI agent replies.
 *
 * The agent reply persisted on the turn's `result` event MUST carry an id that
 * differs from the originating user message's id. If the reply reuses the user
 * message id, two records in the team inbox share one id and the renderer's
 * id-keyed dedup drops the reply — it "vanishes" from the board even though it
 * was produced and persisted. (This was the team-3ond "回复的没了" bug: the
 * member-DM route passed the user message id straight through.)
 *
 * The `direct-` prefix guarantees the id can never collide with a client
 * optimistic id (`optimistic-…`) or a server user-message id; the timestamp +
 * counter keep rapid/concurrent replies distinct.
 */

let replyIdCounter = 0;

export function buildDirectReplyMessageId(sessionKey: string): string {
  replyIdCounter += 1;
  return `direct-${sessionKey}-${Date.now().toString(36)}-${replyIdCounter.toString(36)}`;
}

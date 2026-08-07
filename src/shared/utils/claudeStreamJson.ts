/**
 * Pure per-line classifier for `claude --output-format stream-json` (NDJSON) output.
 *
 * Shared between the main-process DirectCliSessionManager (stdout relay) and any
 * renderer-side interpretation, so the wire-format knowledge lives in one place.
 * Line types mirror the ones the cc-connect `claudecode` agent parses
 * (`agent/claudecode/session.go`): `system` / `assistant` / `user` / `result` /
 * `control_request` / `control_cancel_request`.
 *
 * Note: stream-json emits message-level events (one `assistant` line per completed
 * message), not per-token deltas. Token-by-token feel comes from emitting each
 * assistant message as it lands — consistent with the existing cc-connect path.
 */

export interface ParsedAssistantBlock {
  kind: 'text' | 'thinking' | 'tool-use';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
}

export type ClaudeStreamLine =
  | { type: 'session-init'; sessionId: string; model?: string }
  | { type: 'assistant'; blocks: ParsedAssistantBlock[]; messageId?: string }
  | { type: 'result'; text: string; subtype: string; sessionId?: string }
  | {
      type: 'control-request';
      requestId?: string;
      /** `can_use_tool` = a tool needs interactive approval; other subtypes are auto-allowed. */
      subtype?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
    }
  | { type: 'unknown' }
  | { type: 'parse-error'; line: string };

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * Classify a single NDJSON line from `claude --output-format stream-json`.
 * Returns `null` for blank lines so callers can skip without distinguishing
 * from `unknown` (a valid JSON object we don't model).
 */
export function classifyClaudeStreamLine(line: string): ClaudeStreamLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return { type: 'unknown' };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { type: 'parse-error', line: trimmed };
  }

  const eventType = typeof raw.type === 'string' ? raw.type : '';

  switch (eventType) {
    case 'system': {
      const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
      if (!sessionId) return { type: 'unknown' };
      const model = typeof raw.model === 'string' && raw.model ? raw.model : undefined;
      return { type: 'session-init', sessionId, model };
    }

    case 'assistant': {
      const message = raw.message as Record<string, unknown> | undefined;
      const rawContent = (message?.content ?? raw.content) as RawContentBlock[] | undefined;
      if (!Array.isArray(rawContent)) return { type: 'unknown' };

      const messageId =
        typeof (message?.id ?? raw.id) === 'string'
          ? ((message?.id ?? raw.id) as string)
          : undefined;

      const blocks: ParsedAssistantBlock[] = [];
      for (const block of rawContent) {
        if (!block || typeof block !== 'object') continue;
        switch (block.type) {
          case 'text':
            if (typeof block.text === 'string' && block.text) {
              blocks.push({ kind: 'text', text: block.text });
            }
            break;
          case 'thinking':
            if (typeof block.thinking === 'string' && block.thinking) {
              blocks.push({ kind: 'thinking', text: block.thinking });
            }
            break;
          case 'tool_use':
            blocks.push({
              kind: 'tool-use',
              toolName: typeof block.name === 'string' ? block.name : 'Unknown',
              toolInput: block.input,
              toolId: typeof block.id === 'string' ? block.id : undefined,
            });
            break;
          default:
            break;
        }
      }
      if (!blocks.length) return { type: 'unknown' };
      return { type: 'assistant', blocks, messageId };
    }

    case 'user': {
      // tool_result echo back from the CLI; not needed for streaming display.
      return { type: 'unknown' };
    }

    case 'result': {
      const text = typeof raw.result === 'string' ? raw.result : '';
      const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
      const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
      return { type: 'result', text, subtype, sessionId };
    }

    case 'control_request':
    case 'control_cancel_request': {
      // The CLI nests the gate details under `request`: { subtype, tool_name, input }.
      // Only `subtype: can_use_tool` is a real tool-approval gate; other subtypes are
      // surfaced so the caller can auto-allow them and avoid deadlocking the stream.
      const req =
        raw.request && typeof raw.request === 'object'
          ? (raw.request as Record<string, unknown>)
          : undefined;
      const strField = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const inputRaw = req?.input;
      return {
        type: 'control-request',
        requestId: typeof raw.request_id === 'string' ? raw.request_id : undefined,
        subtype: strField(req?.subtype),
        toolName: strField(req?.tool_name),
        toolInput:
          inputRaw && typeof inputRaw === 'object'
            ? (inputRaw as Record<string, unknown>)
            : undefined,
      };
    }

    default:
      return { type: 'unknown' };
  }
}

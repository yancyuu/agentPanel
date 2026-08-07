/**
 * Lead tool-activity extraction.
 *
 * The Loop console message stream only carries team/group messages — agent tool
 * invocations (Bash/Read/Edit/…) live in the parsed session detail. These helpers
 * flatten recent tool calls out of a parsed session so the console can surface
 * "what the lead agent actually did" alongside the message feed.
 *
 * The input is typed structurally (not as the full `ParsedMessage`) so the pure
 * extraction logic can be unit-tested without constructing an entire parsed
 * session, while still accepting real `ParsedMessage[]` at the call site.
 */

/** Minimal shape of a single tool call we care about for display. */
export interface ToolActivityCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/** Minimal message shape carrying tool calls. `ParsedMessage` satisfies this. */
export interface ToolActivityMessage {
  timestamp: Date | string;
  toolCalls: readonly ToolActivityCall[];
}

/** A display-ready tool-activity entry for the Loop console. */
export interface LeadToolActivity {
  /** Tool name, e.g. "Bash", "Read", "Edit". */
  name: string;
  /** Human-readable preview derived from the tool input. */
  preview: string;
  /** Runtime tool_use identifier when available. */
  toolUseId?: string;
  /** ISO timestamp inherited from the owning message. */
  timestamp: string;
}

/**
 * Build a short human-readable preview from a tool's input args. Mirrors the
 * high-signal fields Claude Code users actually scan for (file paths, commands,
 * patterns) without dumping raw JSON.
 */
export function formatToolPreview(name: string, input: Record<string, unknown>): string {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  switch (name) {
    case 'Bash':
      return str(input.command).trim();
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path).trim();
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern).trim();
      const path = str(input.path).trim();
      return pattern ? (path ? `${pattern}  (in ${path})` : pattern) : path;
    }
    case 'Task':
    case 'Agent': {
      const description = str(input.description).trim();
      const subagent = str(input.subagent_type).trim();
      return description || subagent ? `${subagent ? `[${subagent}] ` : ''}${description}` : '';
    }
    case 'WebFetch':
      return str(input.url).trim();
    case 'WebSearch':
      return str(input.query).trim();
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return todos.length ? `${todos.length} todos` : '';
    }
    default: {
      // Fall back to the first string-valued arg, if any.
      for (const value of Object.values(input)) {
        const text = str(value).trim();
        if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
      }
      return '';
    }
  }
}

/**
 * Flatten the most recent tool calls from a parsed session, newest first.
 *
 * Tool calls inherit their owning message's timestamp (the wire format does not
 * attach one per call), so ordering is stable at message granularity.
 */
export function extractRecentToolActivity(
  messages: readonly ToolActivityMessage[],
  limit: number
): LeadToolActivity[] {
  if (limit <= 0) return [];

  const activities: LeadToolActivity[] = [];
  for (const message of messages) {
    const timestamp =
      message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : String(message.timestamp);
    for (const call of message.toolCalls) {
      activities.push({
        name: call.name,
        preview: formatToolPreview(call.name, call.input),
        toolUseId: call.id,
        timestamp,
      });
    }
  }

  if (activities.length <= limit) return activities.slice().reverse();
  return activities.slice(activities.length - limit).reverse();
}

import type { AttachmentPayload, SlashCommandMeta, TaskRef } from '@shared/types';
import type { WorkflowPromptSummary } from '@shared/types/systemManager';

export type LoopSendIntentKind = 'message' | 'runtime' | 'session' | 'workers-list';

export interface LoopSendIntentBase {
  kind: LoopSendIntentKind;
  text: string;
  summary?: string;
}

export interface LoopMessageIntent extends LoopSendIntentBase {
  kind: 'message';
  recipient: string;
  attachments?: AttachmentPayload[];
  taskRefs?: TaskRef[];
  slashCommand?: SlashCommandMeta;
}

export interface LoopRuntimeIntent extends LoopSendIntentBase {
  kind: 'runtime';
}

export interface LoopSessionIntent extends LoopSendIntentBase {
  kind: 'session';
  sessionName?: string;
  reuse?: boolean;
  workflowPrompt?: WorkflowPromptSummary;
}

export interface LoopWorkersListIntent extends LoopSendIntentBase {
  kind: 'workers-list';
}

export type LoopSendIntent =
  | LoopMessageIntent
  | LoopRuntimeIntent
  | LoopSessionIntent
  | LoopWorkersListIntent;

export interface LoopSendIntentParseOptions {
  text: string;
  recipient: string;
  leadRecipient: string;
  attachments?: AttachmentPayload[];
  taskRefs?: TaskRef[];
  slashCommandMode?: 'message' | 'session';
  workflowPrompts?: readonly WorkflowPromptSummary[];
}

export interface LoopSendIntentValidationContext {
  isTeamAlive?: boolean;
  isProvisioning?: boolean;
}

export interface LoopSendIntentValidationResult {
  ok: boolean;
  reason?: string;
}

function parseDirective(text: string): { directive: string; rest: string } | null {
  const match = /^!(runtime|session|message)\b\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  return {
    directive: match[1].toLowerCase(),
    rest: match[2]?.trim() ?? '',
  };
}

function parseSessionDirective(
  rest: string
): Pick<LoopSessionIntent, 'text' | 'sessionName' | 'reuse'> {
  const reuse = /(?:^|\s)--reuse(?:\s|$)/.test(rest);
  const withoutReuse = rest.replace(/(?:^|\s)--reuse(?=\s|$)/g, ' ').trim();
  const nameMatch = /(?:^|\s)--name\s+"([^"]+)"|(?:^|\s)--name\s+([^\s]+)/.exec(withoutReuse);
  const sessionName = (nameMatch?.[1] ?? nameMatch?.[2])?.trim();
  const text = nameMatch ? withoutReuse.replace(nameMatch[0], ' ').trim() : withoutReuse;
  return { text, sessionName, reuse };
}

export function parseLoopSendIntent(options: LoopSendIntentParseOptions): LoopSendIntent {
  const text = options.text.trim();
  const directive = parseDirective(text);
  const attachments =
    options.attachments && options.attachments.length > 0 ? options.attachments : undefined;
  const taskRefs = options.taskRefs && options.taskRefs.length > 0 ? options.taskRefs : undefined;

  if (directive?.directive === 'runtime') {
    return {
      kind: 'runtime',
      text: directive.rest,
      summary: directive.rest,
    };
  }

  if (directive?.directive === 'session') {
    const session = parseSessionDirective(directive.rest);
    return {
      kind: 'session',
      text: session.text,
      summary: session.text,
      sessionName: session.sessionName,
      reuse: session.reuse,
    };
  }

  const messageText = directive?.directive === 'message' ? directive.rest : text;
  // /workers lists discoverable workers via a client-side API call, so it works
  // in any console mode — including the team (message-mode) console, where it's
  // offered in the command list. Without this it would fall through to a plain
  // lead message that does nothing.
  if (/^\/workers(?:\s|$)/i.test(messageText)) {
    return {
      kind: 'workers-list',
      text: messageText,
      summary: '获取当前数字员工列表',
    };
  }

  if (
    options.slashCommandMode === 'session' &&
    /^\/[a-z][a-z0-9:-]{0,63}(?:\s|$)/i.test(messageText)
  ) {
    const sessionName = messageText.split(/\s+/, 1)[0]?.slice(1) || undefined;
    return {
      kind: 'session',
      text: messageText,
      summary: messageText,
      sessionName,
      reuse: true,
    };
  }

  return {
    kind: 'message',
    recipient: options.recipient || options.leadRecipient,
    text: messageText,
    summary: messageText,
    attachments,
    taskRefs,
  };
}

export function validateLoopSendIntent(
  intent: LoopSendIntent,
  context: LoopSendIntentValidationContext = {}
): LoopSendIntentValidationResult {
  if (!intent.text.trim()) {
    return { ok: false, reason: '请输入要下发的指令。' };
  }

  if (context.isProvisioning) {
    return { ok: false, reason: 'Loop runtime 正在启动中，稍后再下发指令。' };
  }

  if (intent.kind === 'runtime' && context.isTeamAlive === false) {
    return { ok: false, reason: 'Loop runtime 离线，无法直接注入运行时。' };
  }

  if (intent.kind === 'message' && intent.attachments && context.isTeamAlive === false) {
    return { ok: false, reason: 'Loop runtime 离线时不能发送附件。' };
  }

  return { ok: true };
}

export function getLoopSendIntentLabel(intent: LoopSendIntent): string {
  switch (intent.kind) {
    case 'runtime':
      return '注入运行时';
    case 'session':
      return intent.reuse ? '复用本地会话' : '新建本地会话';
    case 'workers-list':
      return '查看数字员工';
    case 'message':
    default:
      return `发送给 ${intent.recipient}`;
  }
}

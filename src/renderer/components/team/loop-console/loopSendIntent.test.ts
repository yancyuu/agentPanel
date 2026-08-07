import { describe, expect, it } from 'vitest';

import {
  getLoopSendIntentLabel,
  parseLoopSendIntent,
  validateLoopSendIntent,
} from './loopSendIntent';

function messageIntent(text = 'do the thing') {
  return parseLoopSendIntent({ text, recipient: 'lead', leadRecipient: 'lead' });
}

describe('validateLoopSendIntent', () => {
  it('rejects empty text with a generic command prompt (no Loop branding)', () => {
    const intent = messageIntent('   ');
    const result = validateLoopSendIntent(intent);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    // The console accepts more than just loop commands — !runtime, !session,
    // and /workflows — so the empty-state prompt must be generic command wording,
    // never branded "Loop 指令".
    expect(result.reason).toMatch(/指令/);
    expect(result.reason).not.toMatch(/Loop/i);
  });

  it('accepts a non-empty message when the team is alive', () => {
    expect(validateLoopSendIntent(messageIntent('hello'), { isTeamAlive: true }).ok).toBe(true);
  });

  it('blocks sends while provisioning', () => {
    const result = validateLoopSendIntent(messageIntent('hello'), { isProvisioning: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/启动/);
  });

  it('blocks runtime injection but allows session creation when the team is offline', () => {
    const runtime = parseLoopSendIntent({
      text: '!runtime do something',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(runtime.kind).toBe('runtime');
    expect(validateLoopSendIntent(runtime, { isTeamAlive: false }).ok).toBe(false);

    const session = parseLoopSendIntent({
      text: '/loop-scan',
      recipient: 'lead',
      leadRecipient: 'lead',
      slashCommandMode: 'session',
    });
    expect(session.kind).toBe('session');
    expect(validateLoopSendIntent(session, { isTeamAlive: false }).ok).toBe(true);
  });

  it('allows a runtime intent when the team is alive', () => {
    const runtime = parseLoopSendIntent({
      text: '!runtime do something',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(runtime.kind).toBe('runtime');
    expect(validateLoopSendIntent(runtime, { isTeamAlive: true }).ok).toBe(true);
  });
});

describe('parseLoopSendIntent /workers', () => {
  it('resolves /workers to workers-list in session (admin) mode', () => {
    const intent = parseLoopSendIntent({
      text: '/workers',
      recipient: 'lead',
      leadRecipient: 'lead',
      slashCommandMode: 'session',
    });
    expect(intent.kind).toBe('workers-list');
  });

  it('resolves /workers to workers-list even in message (team) mode', () => {
    // /workers is offered in the team console too; it must actually run the
    // client-side worker listing there, not silently fall through to a plain
    // lead message that does nothing.
    const intent = parseLoopSendIntent({
      text: '/workers',
      recipient: 'lead',
      leadRecipient: 'lead',
      slashCommandMode: 'message',
    });
    expect(intent.kind).toBe('workers-list');
  });
});

describe('parseLoopSendIntent directives', () => {
  it('strips a !message directive down to its body', () => {
    const intent = parseLoopSendIntent({
      text: '!message ship the feature',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(intent.kind).toBe('message');
    if (intent.kind !== 'message') return;
    expect(intent.text).toBe('ship the feature');
    expect(intent.recipient).toBe('lead');
  });

  it('parses a !session directive with --name and --reuse', () => {
    const intent = parseLoopSendIntent({
      text: '!session --name "my session" --reuse run the scan',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(intent.kind).toBe('session');
    if (intent.kind !== 'session') return;
    expect(intent.sessionName).toBe('my session');
    expect(intent.reuse).toBe(true);
    expect(intent.text).toBe('run the scan');
  });

  it('parses a bare --name token without quotes', () => {
    const intent = parseLoopSendIntent({
      text: '!session --name quick do work',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(intent.kind).toBe('session');
    if (intent.kind !== 'session') return;
    expect(intent.sessionName).toBe('quick');
    expect(intent.reuse).toBe(false);
    expect(intent.text).toBe('do work');
  });

  it('promotes a slash command to a session intent in session mode', () => {
    const intent = parseLoopSendIntent({
      text: '/loop-scan',
      recipient: 'lead',
      leadRecipient: 'lead',
      slashCommandMode: 'session',
    });
    expect(intent.kind).toBe('session');
    if (intent.kind !== 'session') return;
    expect(intent.sessionName).toBe('loop-scan');
    expect(intent.reuse).toBe(true);
  });

  it('keeps @team-looking input as a plain lead message', () => {
    const intent = parseLoopSendIntent({
      text: '@hermit please fix the kanban',
      recipient: 'lead',
      leadRecipient: 'lead',
    });
    expect(intent.kind).toBe('message');
    if (intent.kind !== 'message') return;
    expect(intent.recipient).toBe('lead');
    expect(intent.text).toBe('@hermit please fix the kanban');
  });
});

describe('validateLoopSendIntent edge cases', () => {
  it('rejects attachments while the team is offline', () => {
    const intent = parseLoopSendIntent({
      text: 'see attached',
      recipient: 'lead',
      leadRecipient: 'lead',
      attachments: [{ kind: 'file', path: '/tmp/a.txt' }] as never,
    });
    expect(intent.kind).toBe('message');
    const result = validateLoopSendIntent(intent, { isTeamAlive: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/附件|离线/);
  });
});

describe('getLoopSendIntentLabel', () => {
  it('labels a runtime intent', () => {
    expect(getLoopSendIntentLabel({ kind: 'runtime', text: 'x' })).toBe('注入运行时');
  });

  it('labels a reused vs new session intent', () => {
    expect(getLoopSendIntentLabel({ kind: 'session', text: 'x', reuse: true })).toBe(
      '复用本地会话'
    );
    expect(getLoopSendIntentLabel({ kind: 'session', text: 'x', reuse: false })).toBe(
      '新建本地会话'
    );
  });

  it('labels a workers-list intent', () => {
    expect(getLoopSendIntentLabel({ kind: 'workers-list', text: 'x' })).toBe('查看数字员工');
  });

  it('labels a message intent with its recipient', () => {
    expect(getLoopSendIntentLabel({ kind: 'message', recipient: 'lead', text: 'x' })).toBe(
      '发送给 lead'
    );
  });
});

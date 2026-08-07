import { describe, expect, it } from 'vitest';

import { parseTeamMentionDirective } from '@renderer/utils/teamMentionDirective';

describe('parseTeamMentionDirective', () => {
  it('parses an ASCII @team subject directive', () => {
    expect(parseTeamMentionDirective('@team-jcve 做X')).toEqual({
      mentioned: 'team-jcve',
      subject: '做X',
    });
  });

  it('parses a full-width ＠team subject directive (CJK IME)', () => {
    // Regression: a full-width ＠ (U+FF20) typed under a Chinese IME previously
    // failed the dispatch regex, so the message fell through to a local send and
    // the user's own team answered instead of the mentioned one.
    expect(parseTeamMentionDirective('＠team-jcve 做X')).toEqual({
      mentioned: 'team-jcve',
      subject: '做X',
    });
  });

  it('accepts a full-width space (U+3000) as the separator', () => {
    expect(parseTeamMentionDirective('＠team-jcve　做X')).toEqual({
      mentioned: 'team-jcve',
      subject: '做X',
    });
  });

  it('preserves inner whitespace in the subject', () => {
    expect(parseTeamMentionDirective('@team 帮我看一下 这个 bug')).toEqual({
      mentioned: 'team',
      subject: '帮我看一下 这个 bug',
    });
  });

  it('returns null when there is no subject', () => {
    expect(parseTeamMentionDirective('@team-jcve')).toBeNull();
    expect(parseTeamMentionDirective('@team-jcve   ')).toBeNull();
  });

  it('returns null when the mention is not at the start', () => {
    expect(parseTeamMentionDirective('hello @team-jcve 做X')).toBeNull();
  });

  it('returns null for plain text or empty input', () => {
    expect(parseTeamMentionDirective('你好')).toBeNull();
    expect(parseTeamMentionDirective('')).toBeNull();
  });
});

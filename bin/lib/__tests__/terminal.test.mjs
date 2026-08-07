// terminal.mjs — capability detectors (pure functions of env/platform) and the
// rounded-panel builder. The visual rendering itself is exercised live; these
// tests pin the detection logic that decides truecolor vs 8-color and Unicode
// box-drawing vs ASCII fallback (the Windows-degradation fix).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectAnsi,
  detectTruecolor,
  detectUnicode,
  panelWidth,
  renderRowsPanel,
  menuColumnsLine,
  navHeaderLine,
  rowStatusDot,
  statusBarLine,
  writeFrameSync,
  glyphs,
  displayWidth,
} from '../terminal.mjs';

const SAVED = {};
function stash(keys) {
  for (const k of keys) SAVED[k] = process.env[k];
}
function restore(keys) {
  for (const k of keys) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}

describe('terminal capability detection', () => {
  const ENV_KEYS = ['HERMIT_FORCE_UNICODE', 'TERM', 'WT_SESSION', 'COLORTERM', 'NO_COLOR', 'TERM_PROGRAM'];

  beforeEach(() => stash(ENV_KEYS));
  afterEach(() => restore(ENV_KEYS));

  it('detectUnicode honors an explicit force override either way', () => {
    process.env.HERMIT_FORCE_UNICODE = '0';
    expect(detectUnicode()).toBe(false);
    process.env.HERMIT_FORCE_UNICODE = '1';
    expect(detectUnicode()).toBe(true);
  });

  it('detectUnicode is false on a dumb terminal', () => {
    delete process.env.HERMIT_FORCE_UNICODE;
    process.env.TERM = 'dumb';
    expect(detectUnicode()).toBe(false);
  });

  it('detectUnicode defaults to Unicode on Windows unless explicitly disabled', () => {
    if (process.platform !== 'win32') return; // platform-specific branch
    delete process.env.HERMIT_FORCE_UNICODE;
    delete process.env.WT_SESSION;
    delete process.env.TERM_PROGRAM;
    delete process.env.ConPTY;
    delete process.env.COLORTERM;
    process.env.TERM = '';
    expect(detectUnicode()).toBe(true);
  });

  it('detectUnicode is true on win32 when a UTF-8 host marker is present', () => {
    if (process.platform !== 'win32') return; // platform-specific branch
    delete process.env.HERMIT_FORCE_UNICODE;
    process.env.TERM = 'xterm-256color';
    process.env.WT_SESSION = '1';
    expect(detectUnicode()).toBe(true);
  });

  it('detectTruecolor is true for COLORTERM=truecolor and WT_SESSION', () => {
    delete process.env.WT_SESSION;
    process.env.COLORTERM = 'truecolor';
    expect(detectTruecolor()).toBe(true);
    delete process.env.COLORTERM;
    process.env.WT_SESSION = '1';
    expect(detectTruecolor()).toBe(true);
  });

  it('detectTruecolor is false without a truecolor marker', () => {
    delete process.env.COLORTERM;
    delete process.env.WT_SESSION;
    expect(detectTruecolor()).toBe(false);
  });

  it('detectAnsi is false when NO_COLOR is set', () => {
    // stdout.isTTY is false under vitest, so detectAnsi is already false; this
    // just confirms NO_COLOR keeps it false.
    process.env.NO_COLOR = '1';
    expect(detectAnsi()).toBe(false);
  });
});

describe('menuColumnsLine', () => {
  it('aligns the chip at the anchor column regardless of left width', () => {
    const anchor = 14;
    const wide = menuColumnsLine('❯ ▸ 用量同步', '运行中', anchor);
    const narrow = menuColumnsLine('  ▸ 账号', '已登录', anchor);
    const chipStart = (line, chip) => displayWidth(line.slice(0, line.indexOf(chip)));
    expect(chipStart(wide, '运行中')).toBe(anchor);
    expect(chipStart(narrow, '已登录')).toBe(anchor);
  });

  it('leaves left untouched when there is no chip', () => {
    expect(menuColumnsLine('  ▸ AI 密钥', '', 14)).toBe('  ▸ AI 密钥');
  });
});

describe('renderRowsPanel', () => {
  it('clamps panel width to a readable range', () => {
    const narrow = panelWidth.call(null); // current columns
    expect(narrow).toBeGreaterThanOrEqual(52);
    expect(narrow).toBeLessThanOrEqual(120);
  });

  it('builds top/bottom borders, a title row, and content rows', () => {
    const lines = renderRowsPanel('用量上报状态', [
      ['会话数', '19', 'ok'],
      ['Token 总量', '63.8M'],
    ], '提示文案');
    // top border, 2 content rows, bottom border, hint => >= 5 lines
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines[0].trim()).toMatch(/[╭+]/u); // first border char
    expect(lines.at(-1)).toContain('提示文案'); // hint is last
    const joined = lines.join('\n');
    expect(joined).toContain('用量上报状态');
    expect(joined).toContain('会话数');
    expect(joined).toContain('Token 总量');
  });

  it('renders array values as multiple rows without dropping later lines', () => {
    const lines = renderRowsPanel('在线说明书', [
      ['交给 Claude Code', ['请先阅读 AgentPanel 在线说明书：https://yancyuu.github.io/agentpanel/', '后续回答和操作请以这份说明书为准'], 'ok'],
    ]);

    const joined = lines.join('\n');
    expect(joined).toContain('交给 Claude Code');
    expect(joined).toContain('请先阅读 AgentPanel 在线说明书');
    expect(joined).toContain('后续回答和操作请以这份说明书为准');
  });
});

describe('navHeaderLine', () => {
  it('justifies the diamond brand on the left and the version pinned to width', () => {
    const width = 60;
    const line = navHeaderLine(width);
    // The header fills exactly `width` display columns (brand left, version right).
    expect(displayWidth(line)).toBe(width);
    expect(line.startsWith(glyphs.diamond)).toBe(true);
    expect(line).toContain('v'); // version marker on the right
  });
});

describe('rowStatusDot', () => {
  it('is a hollow dot for inactive states and a filled dot for active ones', () => {
    // Binary on/off indicator — distinct from statusDot's ✓/▲/✕ alphabet.
    expect(rowStatusDot('off')).toBe(glyphs.hollow);
    expect(rowStatusDot('error')).toBe(glyphs.hollow);
    expect(rowStatusDot('warn')).toBe(glyphs.dot); // enabled-but-not-running
    expect(rowStatusDot('ok')).toBe(glyphs.dot);
    expect(rowStatusDot('info')).toBe(glyphs.dot);
    expect(rowStatusDot('unknown')).toBe(glyphs.dot); // default neutral
  });
});

describe('statusBarLine', () => {
  it('renders one justified line for multiple pills (pure — no console side effect)', () => {
    const line = statusBarLine(
      [
        { label: '已登录', state: 'ok' },
        { label: 'Web 未启动', state: 'off' },
      ],
      60,
    );
    expect(typeof line).toBe('string');
    expect(line).toContain('已登录');
    expect(line).toContain('Web 未启动');
  });

  it('returns the empty string when there are no items', () => {
    expect(statusBarLine([], 60)).toBe('');
  });
});

describe('writeFrameSync — flicker-free full-frame redraw', () => {
  // Reproduces "选上下左右页面一闪一闪的": the old clearMenuFrame wrote
  // \x1b[H\x1b[3J\x1b[J on EVERY repaint. \x1b[3J (scrollback wipe) + a full
  // erase-then-redraw is what flashed the screen on each arrow press. The fix
  // redraws IN PLACE: cursor home, overwrite each line with a per-line
  // clear-to-EOL, then erase leftover rows — never wiping the whole screen.
  let frames;
  let realWrite;
  beforeEach(() => {
    frames = [];
    realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { frames.push(String(chunk)); return true; };
  });
  afterEach(() => { process.stdout.write = realWrite; });

  it('homes the cursor and clears each line in place, never wiping the screen', () => {
    writeFrameSync(['row one', 'row two']);
    const out = frames.join('');
    expect(out.startsWith('\x1b[H')).toBe(true); // cursor home, no full erase first
    expect(out).toContain('\x1b[K');             // per-line clear-to-EOL (in-place)
    expect(out).not.toContain('\x1b[2J');        // no full-screen erase (the flash)
    expect(out).not.toContain('\x1b[3J');        // no scrollback wipe (the flash)
    expect(out).toContain('row one');
    expect(out).toContain('row two');
  });

  it('erases leftover rows below a shorter frame so stale lines do not linger', () => {
    writeFrameSync(['short']);
    expect(frames.join('')).toContain('\x1b[J'); // clear-to-end-of-screen tail
  });
});

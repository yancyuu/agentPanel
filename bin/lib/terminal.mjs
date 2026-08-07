// terminal.mjs — ANSI/display primitives, status pills, box drawing, prompts,
// generic table/logo/welcome rendering, JSON output, and the cancel-on-SIGINT
// handler bound to the readline prompt interface. Pure leaf (env + branding).
//
// Visual language follows Claude Code's editorial style: a sky-blue accent
// (#4FC3F7) over 24-bit truecolor with graceful 8-color fallback, rounded panels
// (╭╮╰╯), muted secondary text, and a minimal wordmark. Capability (truecolor
// + Unicode box drawing) is DETECTED, not assumed by platform — modern Windows
// Terminal renders UTF-8 fine, only legacy conhost/dumb terminals degrade.

import { createInterface } from 'node:readline/promises';

import { BRAND } from '../branding.mjs';
import { currentVersion, jsonRequested } from './env.mjs';

let cancelHandled = false;

function cancelCli() {
  if (cancelHandled) return;
  cancelHandled = true;
  const message = process.stdout.isTTY && process.env.NO_COLOR !== '1' ? `\x1b[2m已退出 ${BRAND.stylizedName} 终端\x1b[0m` : `已退出 ${BRAND.stylizedName} 终端`;
  console.log(`\n${message}`);
  process.exit(130);
}
function printJson(value, exitCode = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(exitCode);
}
const CLI_MENU_WIDTH = 72;

// --- Capability detection --------------------------------------------------
// Replaces the old `useUnicodeUi = platform !== 'win32'` blanket, which degraded
// every Windows install to ASCII boxes even on Windows Terminal.
function detectAnsi() {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
}
function detectTruecolor() {
  if (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit') return true;
  if (process.env.WT_SESSION) return true; // Windows Terminal advertises 24-bit
  return false;
}
function detectUnicode() {
  if (process.env.HERMIT_FORCE_UNICODE === '1') return true;
  if (process.env.HERMIT_FORCE_UNICODE === '0') return false;
  const term = (process.env.TERM || '').toLowerCase();
  if (term === 'dumb') return false;
  return true;
}

const useAnsi = detectAnsi();
const useTruecolor = useAnsi && detectTruecolor();
const useUnicodeUi = detectUnicode();

const glyphs = useUnicodeUi
  ? { h: '─', v: '│', tl: '╭', tr: '╮', ml: '├', mr: '┤', bl: '╰', br: '╯', dot: '●', hollow: '○', diamond: '◆', warnMark: '▲', cross: '✕', pointer: '❯', checked: '✓', unchecked: ' ', caretOpen: '▾', caretClosed: '▸' }
  : { h: '-', v: '|', tl: '+', tr: '+', ml: '+', mr: '+', bl: '+', br: '+', dot: '*', hollow: 'o', diamond: '+', warnMark: '!', cross: 'x', pointer: '>', checked: 'x', unchecked: ' ', caretOpen: 'v', caretClosed: '>' };

// 24-bit palette (R;G;B) with basic 8-color SGR fallbacks for terminals without
// truecolor. Accent is blue (the CLI's established accent color); status colors
// stay muted (olive/sand/terracotta) so they read clearly against the blue accent.
const TRUECOLOR = {
  accent: '79;195;247', // #4FC3F7 sky blue (menu pointer / title / brand)
  success: '120;140;93', // #788c5d muted olive
  warn: '212;162;127', // #d4a27f warm sand
  danger: '193;95;60', // #C15F3C deep terracotta
  info: '106;155;204', // #6a9bcc muted blue
  dim: '150;146;137', // muted gray (panel borders / secondary text)
};
const ANSI_FALLBACK = { accent: '36', success: '32', warn: '33', danger: '31', info: '36', dim: '2' };

function ansi(value, code) {
  return useAnsi ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function paint(value, rgbCode, ansiCode) {
  if (!useAnsi) return value;
  return useTruecolor
    ? `\x1b[38;2;${rgbCode}m${value}\x1b[0m`
    : `\x1b[${ansiCode}m${value}\x1b[0m`;
}

const ui = {
  bold: (value) => ansi(value, '1'),
  dim: (value) => paint(value, TRUECOLOR.dim, ANSI_FALLBACK.dim),
  accent: (value) => paint(value, TRUECOLOR.accent, ANSI_FALLBACK.accent),
  success: (value) => paint(value, TRUECOLOR.success, ANSI_FALLBACK.success),
  warn: (value) => paint(value, TRUECOLOR.warn, ANSI_FALLBACK.warn),
  danger: (value) => paint(value, TRUECOLOR.danger, ANSI_FALLBACK.danger),
  info: (value) => paint(value, TRUECOLOR.info, ANSI_FALLBACK.info),
};
function isInteractiveCli() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function createPromptInterface() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', cancelCli);
  return rl;
}

async function askText(rl, label, defaultValue = '') {
  const suffix = defaultValue ? `  默认：${defaultValue}` : '';
  const answer = (await rl.question(`\n${label}${suffix}\n› `)).trim();
  return answer || defaultValue;
}

async function askRequired(rl, label, defaultValue = '') {
  while (true) {
    const answer = await askText(rl, label, defaultValue);
    if (answer.trim()) return answer.trim();
    console.log('  这个值不能为空。');
  }
}

async function askChoice(rl, label, choices, defaultValue) {
  console.log(`\n${label}`);
  choices.forEach((choice, index) => {
    const marker = choice === defaultValue ? '  推荐' : '';
    console.log(`  ${index + 1}. ${choice}${marker}`);
  });
  while (true) {
    const answer = (await rl.question(`› 请选择 1-${choices.length}，直接回车使用 ${defaultValue}: `)).trim();
    if (!answer) return defaultValue;
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    if (choices.includes(answer)) return answer;
    console.log('  无效选择，请重新输入。');
  }
}

function charDisplayWidth(char) {
  return /[ᄀ-ᅟ〈〉⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/u.test(char) ? 2 : 1;
}

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function displayWidth(value) {
  return Array.from(stripAnsi(value)).reduce((sum, char) => sum + charDisplayWidth(char), 0);
}

function fitDisplay(value, width) {
  let result = '';
  let used = 0;
  for (const char of Array.from(String(value))) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result + ' '.repeat(Math.max(0, width - used));
}

function truncateDisplay(value, width) {
  const raw = String(value);
  if (displayWidth(raw) <= width) return raw;

  let result = '';
  let used = 0;
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '\x1b' && raw[i + 1] === '[') {
      const match = raw.slice(i).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }
    const char = Array.from(raw.slice(i))[0];
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > Math.max(0, width - 1)) break;
    result += char;
    used += charWidth;
    i += char.length;
  }
  return `${result}…`;
}

function statusDot(state) {
  if (state === 'ok') return ui.success(glyphs.checked); // ✓
  if (state === 'warn') return ui.warn(glyphs.warnMark); // ▲
  if (state === 'error') return ui.danger(glyphs.cross); // ✕
  if (state === 'off') return ui.dim(glyphs.hollow); // ○
  return ui.accent(glyphs.dot); // ● neutral / info
}

// Menu-row chip indicator: filled ● for any active state, hollow ○ for inactive.
// Deliberately distinct from statusDot (✓/▲/✕/○/●) — the nav menu reads cleaner
// with a binary on/off dot beside each chip than the full status alphabet, which
// made the menu look like a debug status table ("全是字") rather than a clean UI.
function rowStatusDot(state) {
  if (state === 'off' || state === 'error') return ui.dim(glyphs.hollow); // ○ inactive
  if (state === 'warn') return ui.warn(glyphs.dot); // ● enabled-but-not-running
  return ui.success(glyphs.dot); // ● ok / info
}

function formatStatusPill(label, state = 'info') {
  return `${statusDot(state)} ${label}`;
}

function colorByState(value, state) {
  if (state === 'ok') return ui.success(value);
  if (state === 'warn') return ui.warn(value);
  if (state === 'error') return ui.danger(value);
  if (state === 'off') return ui.dim(value);
  return value;
}

function rowStateFromValue(value, fallback = 'info') {
  const text = stripAnsi(value);
  if (/失败|错误|异常|未运行|无效|不可用/u.test(text)) return 'error';
  if (/等待|未知|未连接|正在|请先/u.test(text)) return 'warn';
  if (/关闭|未登录|未启用|不支持/u.test(text)) return 'off';
  if (/开启|已启动|已运行|运行中|正常|已登录|成功/u.test(text)) return 'ok';
  return fallback;
}

// Justifies the pills across `width` so the nav-menu status bar reads as one
// balanced line (✓ 已登录 … ○ Web 未启动 … ○ 上报未开启) instead of a `·`-joined
// run clumped at the left. Single pill prints left-aligned. Pure (returns the
// string) so renderNavMenu can drop it into a writeFrameSync buffer.
function statusBarLine(items = [], width = panelWidth()) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return '';
  const cells = visible.map((item) => `${statusDot(item.state)} ${colorByState(item.label, item.state)}`);
  if (visible.length === 1) return cells[0];
  const total = cells.reduce((sum, cell) => sum + displayWidth(cell), 0);
  const gap = Math.max(2, Math.floor((width - total) / (visible.length - 1)));
  return cells.join(' '.repeat(gap));
}
function printStatusBar(items = [], width = panelWidth()) {
  const line = statusBarLine(items, width);
  if (line) console.log(line);
}

function boxLine(left, fill = glyphs.h, right = left) {
  return ui.dim(`${left}${fill.repeat(CLI_MENU_WIDTH)}${right}`);
}

function boxContentLine(content = '') {
  const maxContentWidth = CLI_MENU_WIDTH - 1;
  const visible = truncateDisplay(content, maxContentWidth);
  const padding = ' '.repeat(Math.max(0, maxContentWidth - displayWidth(visible)));
  return `${ui.dim(glyphs.v)} ${visible}${padding}${ui.dim(glyphs.v)}`;
}

function boxColumnsLine(left = '', right = '') {
  const maxContentWidth = CLI_MENU_WIDTH - 1;
  const rightVisible = truncateDisplay(right, 18);
  const leftWidth = Math.max(1, maxContentWidth - displayWidth(rightVisible) - 2);
  const leftVisible = truncateDisplay(left, leftWidth);
  const gap = ' '.repeat(Math.max(2, maxContentWidth - displayWidth(leftVisible) - displayWidth(rightVisible)));
  return `${ui.dim(glyphs.v)} ${leftVisible}${gap}${rightVisible}${ui.dim(glyphs.v)}`;
}

// Pad `left` out to `anchor` display columns, then append the state chip. Left
// is never truncated — the caller passes an anchor just past the widest label so
// chips from every row align tightly instead of floating at the screen edge.
function menuColumnsLine(left = '', right = '', anchor = CLI_MENU_WIDTH) {
  if (!right) return left;
  const pad = ' '.repeat(Math.max(1, anchor - displayWidth(left)));
  return `${left}${pad}${right}`;
}

// Adaptive panel width for the rounded status panels (printCliRows). Falls back
// to a sane fixed width when stdout has no columns (pipes, tests).
function panelWidth() {
  const columns = Number(process.stdout.columns) || 100;
  // Cap at 120 (was 80) so wide status rows — e.g. the per-provider upload rows
  // carrying cursor hash + message count + timestamp — are no longer truncated
  // to "2026/7/9 1…" on terminals that have room. Still adaptive: a genuinely
  // narrow terminal stays narrow (floor 52).
  return Math.max(52, Math.min(columns - 2, 120));
}

// Build the lines of a rounded status panel (╭─ title ─╮ │ rows │ ╰─╯). Pure
// (returns string[]) so it can be unit-tested and snapshotted independently of
// the detected terminal capabilities.
function renderRowsPanel(title, rows = [], hint = '') {
  const width = panelWidth();
  const inner = Math.max(20, width - 2); // between left/right border chars
  const contentW = Math.max(10, inner - 2); // minus one space pad each side
  const lines = [];

  const titleVis = title ? displayWidth(title) : 0;
  if (title) {
    const trailing = Math.max(0, inner - 3 - titleVis); // "─ title " + dashes
    lines.push(
      `${ui.dim(glyphs.tl)}${ui.dim('─ ')}${ui.accent(ui.bold(title))}${ui.dim(` ${glyphs.h.repeat(trailing)}`)}${ui.dim(glyphs.tr)}`
    );
  } else {
    lines.push(`${ui.dim(glyphs.tl)}${ui.dim(glyphs.h.repeat(inner))}${ui.dim(glyphs.tr)}`);
  }

  const labelWidth = Math.max(4, ...rows.map(([label]) => displayWidth(String(label))));
  for (const [label, value, state] of rows) {
    const resolvedState = state || rowStateFromValue(value);
    const valueW = Math.max(8, contentW - labelWidth - 4);
    const values = Array.isArray(value) ? value : [value];
    values.forEach((lineValue, index) => {
      const valueText = truncateDisplay(colorByState(String(lineValue), resolvedState), valueW);
      const labelText = index === 0 ? fitDisplay(String(label), labelWidth) : ' '.repeat(labelWidth);
      const content = `${statusDot(resolvedState)} ${labelText}  ${valueText}`;
      const pad = ' '.repeat(Math.max(0, contentW - displayWidth(content)));
      lines.push(`${ui.dim(glyphs.v)} ${content}${pad} ${ui.dim(glyphs.v)}`);
    });
  }

  lines.push(`${ui.dim(glyphs.bl)}${ui.dim(glyphs.h.repeat(inner))}${ui.dim(glyphs.br)}`);
  if (hint) lines.push(` ${ui.dim(hint)}`);
  return lines;
}

function printCliRows(title, rows = [], hint = '', options = {}) {
  if (options.screen === true && isInteractiveCli() && !jsonRequested) {
    clearTerminal();
    printWelcomeLogo();
    console.log(menuBrandTitle());
  }
  if (useUnicodeUi) {
    // Claude-style rounded panel. Non-Unicode terminals fall through to the
    // plain aligned rows below so output stays readable without box chars.
    for (const line of renderRowsPanel(title, rows, hint)) console.log(line);
    return;
  }
  const labelWidth = Math.max(4, ...rows.map(([label]) => displayWidth(String(label))));
  console.log('');
  console.log(ui.bold(title));
  for (const [label, value, state] of rows) {
    const resolvedState = state || rowStateFromValue(value);
    console.log(`  ${statusDot(resolvedState)} ${fitDisplay(String(label), labelWidth)}  ${colorByState(value, resolvedState)}`);
  }
  if (hint) console.log(ui.dim(`\n提示: ${hint}`));
}

function menuBrandTitle() {
  return `${ui.accent(ui.bold(BRAND.stylizedName))} ${ui.dim(`v${currentVersion}`)}`;
}

// Nav-menu header rule: brand diamond + name on the left, version pinned to the
// right edge of `width`. This is the one place the ◆ wordmark appears —
// menuBrandTitle (the bare `Brand v1.x` wordmark) stays bare for the busy
// overlay and status panels, so the diamond marks the top-level nav only.
function navHeaderLine(width = panelWidth()) {
  const left = `${glyphs.diamond}  ${BRAND.stylizedName}`;
  const right = `v${currentVersion}`;
  const gap = ' '.repeat(Math.max(2, width - displayWidth(left) - displayWidth(right)));
  return `${ui.accent(glyphs.diamond)}  ${ui.accent(ui.bold(BRAND.stylizedName))}${gap}${ui.dim(right)}`;
}

function logoBorderLine() {
  const columns = Number(process.stdout.columns || 80);
  const width = Math.max(24, Math.min(30, columns - 16));
  return ui.dim('…'.repeat(width));
}

// The header wordmark is printed by menuBrandTitle() (callers in hermit.mjs do
// `printWelcomeLogo()` then `console.log(menuBrandTitle())`). Returning [] here
// keeps printWelcomeLogo as a no-op so the wordmark renders exactly once instead
// of duplicating across the nav menu and status panels.
function welcomeLogoLines() {
  return [];
}

function printWelcomeLogo() {
  for (const line of welcomeLogoLines()) console.log(line);
}

function clearTerminal() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function clearTerminalScrollback() {
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
}

// Flicker-free full-frame redraw. Used on every menu repaint (arrow keys,
// expand/collapse, status refresh). The old approach cleared the whole screen
// (\x1b[H\x1b[3J\x1b[J) on each keypress — the scrollback wipe + blank-then-
// redraw is what made the page flash ("一闪一闪") whenever ↑/↓ was pressed.
// Instead: move the cursor home, overwrite each line IN PLACE with a per-line
// clear-to-EOL (\x1b[K) so a shorter frame leaves no stale tail, then erase any
// leftover rows below (\x1b[J). No \x1b[2J / \x1b[3J, so there is never a blank
// gap for the eye to catch — old pixels stay visible until overwritten.
function writeFrameSync(lines) {
  let out = '\x1b[H';
  for (const line of lines) out += `\r${line}\x1b[K\n`;
  out += '\x1b[J';
  process.stdout.write(out);
}

/**
 * Shared braille spinner frames, used by every CLI spinner so the look is
 * consistent across mac / windows / linux. We intentionally do NOT downgrade to
 * ASCII based on terminal detection: modern terminals (Windows Terminal, VS
 * Code, iTerm, Ghostty, …) all render braille. HERMIT_SPINNER_ASCII=1 is kept
 * as an escape hatch for the rare legacy console that can't.
 */
const SPINNER_FRAMES = /^(1|true|yes)$/i.test(
  String(process.env.HERMIT_SPINNER_ASCII ?? '').trim()
)
  ? ['-', '\\', '|', '/']
  : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Run `task` while showing a single-line spinner. The label is produced by
 * `getLabel()` on each frame so it can reflect live progress (status, elapsed).
 * Clears the line on exit. Runs the task directly (no spinner) when stdout is
 * not a TTY — the standard CLI loading pattern that neither clears the screen
 * nor flickers, so it stays clean on Windows GBK consoles where a full-screen
 * repaint would re-emit CJK as mojibake.
 */
async function withSpinner(getLabel, task) {
  if (!process.stdout.isTTY) return task();
  const frames = SPINNER_FRAMES;
  let index = 0;
  const render = () => {
    process.stdout.write(`\r\x1b[2K${ui.dim(frames[index])} ${getLabel()}`);
    index = (index + 1) % frames.length;
  };
  render();
  const timer = setInterval(render, 120);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  }
}


export {
  cancelCli,
  printJson,
  ansi,
  paint,
  ui,
  glyphs,
  CLI_MENU_WIDTH,
  useAnsi,
  useTruecolor,
  useUnicodeUi,
  detectAnsi,
  detectTruecolor,
  detectUnicode,
  isInteractiveCli,
  createPromptInterface,
  askText,
  askRequired,
  askChoice,
  charDisplayWidth,
  stripAnsi,
  displayWidth,
  fitDisplay,
  truncateDisplay,
  statusDot,
  rowStatusDot,
  formatStatusPill,
  colorByState,
  rowStateFromValue,
  statusBarLine,
  printStatusBar,
  boxLine,
  boxContentLine,
  boxColumnsLine,
  menuColumnsLine,
  panelWidth,
  renderRowsPanel,
  printCliRows,
  menuBrandTitle,
  navHeaderLine,
  logoBorderLine,
  welcomeLogoLines,
  printWelcomeLogo,
  clearTerminal,
  clearTerminalScrollback,
  writeFrameSync,
  withSpinner,
  SPINNER_FRAMES,
};

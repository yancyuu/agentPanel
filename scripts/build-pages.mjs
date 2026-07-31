import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '_site');

const { version: DESKTOP_VERSION } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const RELEASE_BASE = `https://github.com/yancyuu/agentcli/releases/download/${DESKTOP_VERSION}`;
const DOWNLOADS = {
  macArm: {
    label: 'macOS 客户端',
    shortLabel: 'macOS Apple Silicon',
    detail: 'Apple Silicon · DMG · 211 MB',
    filename: `AgentCLI-${DESKTOP_VERSION}-arm64.dmg`,
    href: `${RELEASE_BASE}/AgentCLI-${DESKTOP_VERSION}-arm64.dmg`,
    kind: 'desktop',
  },
  macIntel: {
    label: 'macOS Intel 客户端',
    shortLabel: 'macOS Intel',
    detail: 'Intel x64 · DMG · 216 MB',
    filename: `AgentCLI-${DESKTOP_VERSION}-x64.dmg`,
    href: `${RELEASE_BASE}/AgentCLI-${DESKTOP_VERSION}-x64.dmg`,
    kind: 'desktop',
  },
  windows: {
    label: 'Windows x64 客户端',
    shortLabel: 'Windows x64',
    detail: 'Windows x64 · 安装程序 · 187 MB',
    filename: `AgentCLI-Setup-${DESKTOP_VERSION}-x64.exe`,
    href: `${RELEASE_BASE}/AgentCLI-Setup-${DESKTOP_VERSION}-x64.exe`,
    kind: 'desktop',
  },
  windowsArm: {
    label: 'Windows ARM64 客户端',
    shortLabel: 'Windows ARM64',
    detail: 'Windows ARM64 · 安装程序 · 179 MB',
    filename: `AgentCLI-Setup-${DESKTOP_VERSION}-arm64.exe`,
    href: `${RELEASE_BASE}/AgentCLI-Setup-${DESKTOP_VERSION}-arm64.exe`,
    kind: 'desktop',
  },
  linux: {
    label: 'Linux x64 客户端',
    shortLabel: 'Linux x64',
    detail: 'Linux x64 · AppImage · 198 MB',
    filename: `AgentCLI-${DESKTOP_VERSION}-x86_64.AppImage`,
    href: `${RELEASE_BASE}/AgentCLI-${DESKTOP_VERSION}-x86_64.AppImage`,
    kind: 'desktop',
  },
  linuxArm: {
    label: 'Linux ARM64 客户端',
    shortLabel: 'Linux ARM64',
    detail: 'Linux ARM64 · AppImage · 197 MB',
    filename: `AgentCLI-${DESKTOP_VERSION}-arm64.AppImage`,
    href: `${RELEASE_BASE}/AgentCLI-${DESKTOP_VERSION}-arm64.AppImage`,
    kind: 'desktop',
  },
};

function writeText(relativePath, content) {
  const target = join(OUT_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content.trimStart(), 'utf8');
}

function copyFile(fromRelative, toRelative = fromRelative) {
  const source = join(ROOT, fromRelative);
  if (!existsSync(source)) return;
  const target = join(OUT_DIR, toRelative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AgentCLI — 把任务交给 AI 助手，集中查看进度和结果</title>
  <meta name="description" content="写下要做的事，附上相关资料，再选择一个 AI 助手或一支小队。任务进度、完成结果和后续修改都可以在一个桌面应用里查看。" />
  <meta property="og:title" content="AgentCLI — 桌面 AI 任务助手" />
  <meta property="og:description" content="提交任务、查看进度、阅读结果，需要调整时直接继续回复。" />
  <meta property="og:type" content="website" />
  <meta name="theme-color" content="#1769aa" />
  <link rel="icon" type="image/png" sizes="1024x1024" href="icon.png?v=${DESKTOP_VERSION}" />
  <link rel="apple-touch-icon" href="icon.png?v=${DESKTOP_VERSION}" />
  <meta property="og:image" content="https://yancyuu.github.io/agentcli/icon.png?v=${DESKTOP_VERSION}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:image" content="https://yancyuu.github.io/agentcli/icon.png?v=${DESKTOP_VERSION}" />
  <style>
    :root {
      --ink: #10233d;
      --muted: #58708d;
      --line: rgba(26, 72, 118, 0.14);
      --paper: #f7f9fc;
      --white: #ffffff;
      --blue-950: #073967;
      --blue-900: #09528a;
      --blue-800: #126eb2;
      --blue-700: #2387ca;
      --blue-100: #e8f5ff;
      --pink: #f5a9bd;
      --lavender: #bbb3ff;
      --green: #1c9b75;
      --shadow: 0 30px 90px rgba(5, 43, 78, 0.18);
      color-scheme: light;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; overflow-x: hidden; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    a { color: inherit; text-decoration: none; }
    button, select { font: inherit; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.92em;
      background: #eef3f8;
      border: 1px solid #dce6ef;
      border-radius: 7px;
      padding: 2px 6px;
    }

    .site-header {
      position: fixed;
      inset: 0 0 auto;
      z-index: 50;
      height: 76px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(12, 92, 151, 0.72);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      color: white;
    }
    .nav {
      width: min(1240px, calc(100% - 48px));
      height: 100%;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .brand { display: inline-flex; align-items: center; gap: 11px; font-weight: 750; letter-spacing: -0.02em; font-size: 20px; }
    .brand-mark { width: 30px; height: 30px; border-radius: 9px; box-shadow: 0 8px 24px rgba(4, 35, 68, 0.24); }
    .nav-links { display: flex; align-items: center; gap: 30px; margin-left: auto; }
    .nav-links a { color: rgba(255, 255, 255, 0.82); font-size: 14px; }
    .nav-links a:hover { color: white; }
    .nav-download { padding: 10px 17px; border-radius: 11px; background: white; color: var(--blue-950) !important; font-weight: 700; }

    .hero {
      position: relative;
      overflow: hidden;
      min-height: 980px;
      padding: 150px 24px 0;
      color: white;
      text-align: center;
      background:
        radial-gradient(circle at 16% 72%, rgba(245, 169, 189, 0.88) 0, rgba(245, 169, 189, 0) 24%),
        radial-gradient(circle at 82% 43%, rgba(187, 179, 255, 0.58) 0, rgba(187, 179, 255, 0) 22%),
        linear-gradient(180deg, #1268ad 0%, #238acb 58%, #83c9ee 100%);
    }
    .hero::before,
    .hero::after {
      content: "";
      position: absolute;
      pointer-events: none;
      filter: blur(1px);
      opacity: 0.9;
    }
    .hero::before {
      width: 680px;
      height: 360px;
      left: -210px;
      bottom: 170px;
      border-radius: 48% 52% 55% 45%;
      transform: rotate(12deg);
      background: linear-gradient(140deg, rgba(255, 210, 220, 0.95), rgba(120, 195, 236, 0.08) 68%);
      clip-path: polygon(0 76%, 16% 45%, 25% 62%, 40% 20%, 52% 58%, 67% 34%, 81% 68%, 100% 48%, 100% 100%, 0 100%);
    }
    .hero::after {
      width: 620px;
      height: 320px;
      right: -190px;
      bottom: 70px;
      background: linear-gradient(145deg, rgba(202, 188, 255, 0.9), rgba(80, 157, 218, 0.06) 68%);
      clip-path: polygon(0 58%, 17% 37%, 30% 66%, 44% 25%, 58% 55%, 72% 35%, 84% 62%, 100% 42%, 100% 100%, 0 100%);
    }
    .hero-inner { position: relative; z-index: 2; max-width: 990px; margin: 0 auto; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 13px;
      border: 1px solid rgba(255,255,255,0.24);
      border-radius: 999px;
      background: rgba(2, 47, 87, 0.14);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0.04em;
    }
    .eyebrow-dot { width: 7px; height: 7px; border-radius: 50%; background: #8ff1d0; box-shadow: 0 0 0 5px rgba(143,241,208,0.12); }
    .hero h1 {
      max-width: 940px;
      margin: 32px auto 22px;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif;
      font-size: clamp(56px, 8vw, 104px);
      font-weight: 500;
      letter-spacing: -0.055em;
      line-height: 0.98;
      text-wrap: balance;
    }
    .hero-lede {
      max-width: 760px;
      margin: 0 auto;
      color: rgba(255,255,255,0.88);
      font-size: clamp(17px, 2vw, 21px);
      line-height: 1.75;
    }
    .hero-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 31px; }
    .button {
      min-height: 50px;
      padding: 0 22px;
      border: 0;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      cursor: pointer;
      font-weight: 720;
      transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
    }
    .button:hover { transform: translateY(-2px); }
    .button-primary { background: white; color: var(--blue-950); box-shadow: 0 15px 38px rgba(3, 41, 74, 0.2); }
    .button-secondary { color: white; background: rgba(3, 50, 91, 0.22); border: 1px solid rgba(255,255,255,0.22); }
    .download-context { min-height: 23px; margin-top: 12px; color: rgba(255,255,255,0.72); font-size: 13px; }
    .works-with { margin-top: 35px; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 18px; color: rgba(255,255,255,0.78); font-size: 14px; }
    .works-with strong { color: white; font-weight: 650; }
    .runtime-dot { opacity: .5; }

    .product-shot {
      position: relative;
      z-index: 3;
      width: min(1240px, calc(100% - 56px));
      margin: 52px auto 0;
      padding: 8px;
      border: 1px solid rgba(255,255,255,0.52);
      border-radius: 22px 22px 0 0;
      background: rgba(255,255,255,0.48);
      box-shadow: 0 40px 110px rgba(0, 43, 79, 0.34);
      backdrop-filter: blur(14px);
    }
    .window-bar { height: 32px; border-radius: 14px 14px 0 0; background: #f7f8fa; display: flex; align-items: center; gap: 7px; padding: 0 13px; }
    .window-dot { width: 9px; height: 9px; border-radius: 50%; }
    .window-dot.red { background: #ff6b67; }
    .window-dot.yellow { background: #ffc857; }
    .window-dot.green { background: #55c878; }
    .product-shot img { display: block; width: 100%; border-radius: 0 0 13px 13px; background: white; }

    .trust-strip { background: white; border-bottom: 1px solid var(--line); }
    .trust-grid { width: min(1180px, calc(100% - 48px)); margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); }
    .trust-item { padding: 27px 22px; border-right: 1px solid var(--line); }
    .trust-item:last-child { border-right: 0; }
    .trust-item strong { display: block; margin-bottom: 3px; font-size: 14px; }
    .trust-item span { color: var(--muted); font-size: 13px; }

    .section { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 112px 0; }
    .section-kicker { color: var(--blue-700); font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    .section h2 { margin: 12px 0 18px; max-width: 760px; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: clamp(42px, 5vw, 66px); font-weight: 500; line-height: 1.04; letter-spacing: -.045em; }
    .section-intro { max-width: 700px; margin: 0; color: var(--muted); font-size: 18px; }

    .feature-split { display: grid; grid-template-columns: .88fr 1.12fr; align-items: center; gap: 78px; }
    .feature-split.reverse { grid-template-columns: 1.12fr .88fr; }
    .feature-split.reverse .feature-copy { order: 2; }
    .feature-split.reverse .feature-visual { order: 1; }
    .feature-copy h2 { font-size: clamp(40px, 4.5vw, 62px); }
    .feature-points { display: grid; gap: 20px; margin-top: 32px; }
    .feature-point { display: grid; grid-template-columns: 34px 1fr; gap: 13px; }
    .feature-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: var(--blue-800); background: var(--blue-100); font-weight: 800; }
    .feature-point strong { display: block; font-size: 15px; }
    .feature-point p { margin: 3px 0 0; color: var(--muted); font-size: 14px; }
    .feature-visual { position: relative; padding: 16px; border: 1px solid var(--line); border-radius: 22px; background: white; box-shadow: 0 24px 65px rgba(31, 75, 116, 0.13); }
    .feature-visual::before { content: ""; position: absolute; inset: -28px; z-index: -1; border-radius: 42px; background: radial-gradient(circle at 20% 30%, rgba(103,188,238,.25), transparent 55%), radial-gradient(circle at 90% 80%, rgba(245,169,189,.28), transparent 50%); }
    .feature-visual img { width: 100%; display: block; border-radius: 13px; }

    .workflow-section { padding-top: 42px; }
    .workflow-head { text-align: center; }
    .workflow-head h2, .workflow-head .section-intro { margin-left: auto; margin-right: auto; }
    .workflow-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 48px; }
    .workflow-card { position: relative; overflow: hidden; min-height: 230px; padding: 25px; border: 1px solid var(--line); border-radius: 20px; background: white; }
    .workflow-number { color: rgba(24, 111, 174, .15); font-family: Georgia, serif; font-size: 78px; line-height: .8; }
    .workflow-card h3 { margin: 25px 0 8px; font-size: 18px; }
    .workflow-card p { margin: 0; color: var(--muted); font-size: 14px; }

    .download-section { width: min(1180px, calc(100% - 48px)); margin: 30px auto 110px; overflow: hidden; border-radius: 30px; color: white; background: linear-gradient(135deg, #073b69 0%, #126fb0 56%, #4da2d3 100%); box-shadow: var(--shadow); }
    .download-inner { display: grid; grid-template-columns: .95fr 1.05fr; gap: 58px; padding: 70px; }
    .download-copy h2 { margin: 10px 0 18px; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: clamp(42px, 5vw, 66px); font-weight: 500; letter-spacing: -.045em; line-height: 1.02; }
    .download-copy p { color: rgba(255,255,255,.76); }
    .download-card { padding: 27px; border: 1px solid rgba(255,255,255,.2); border-radius: 20px; background: rgba(4, 44, 77, .24); backdrop-filter: blur(10px); }
    .detected-label { color: #9eeed7; font-size: 12px; font-weight: 800; letter-spacing: .12em; }
    .download-card h3 { margin: 9px 0 6px; font-size: 24px; }
    .download-detail { min-height: 24px; color: rgba(255,255,255,.66); font-size: 13px; }
    .download-card .button { width: 100%; margin-top: 19px; }
    .platform-select { width: 100%; margin-top: 13px; padding: 11px 12px; color: white; border: 1px solid rgba(255,255,255,.2); border-radius: 10px; background: rgba(1, 31, 56, .28); }
    .platform-select option { color: #142236; background: white; }
    .download-note { margin: 12px 0 0 !important; font-size: 12px; }
    .all-downloads { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid rgba(255,255,255,.13); }
    .all-downloads a { padding: 18px 20px; border-right: 1px solid rgba(255,255,255,.13); border-bottom: 1px solid rgba(255,255,255,.13); }
    .all-downloads a:nth-child(3n) { border-right: 0; }
    .all-downloads a:nth-last-child(-n+3) { border-bottom: 0; }
    .all-downloads strong { display: block; font-size: 13px; }
    .all-downloads span { color: rgba(255,255,255,.58); font-size: 11px; }

    .advanced { width: min(1020px, calc(100% - 48px)); margin: 0 auto 100px; }
    .advanced-card { border: 1px solid var(--line); border-radius: 20px; background: white; overflow: hidden; }
    .advanced-card summary { cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 25px 28px; font-weight: 760; }
    .advanced-card summary::-webkit-details-marker { display: none; }
    .advanced-card summary span { color: var(--muted); font-size: 13px; font-weight: 500; }
    .advanced-body { padding: 0 28px 30px; border-top: 1px solid var(--line); }
    .advanced-body h3 { margin: 27px 0 8px; }
    .advanced-body p, .advanced-body li { color: var(--muted); font-size: 14px; }
    .command-box { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 13px 0; padding: 15px 17px; border: 1px solid #dce6ef; border-radius: 12px; background: #f7f9fb; }
    .command-box code { border: 0; padding: 0; background: none; color: #176fae; word-break: break-all; }
    .copy-button { border: 0; border-radius: 8px; padding: 7px 10px; color: var(--blue-800); background: var(--blue-100); cursor: pointer; flex: 0 0 auto; }

    .faq { width: min(900px, calc(100% - 48px)); margin: 0 auto; padding: 20px 0 110px; }
    .faq h2 { text-align: center; margin-bottom: 32px; font-family: Iowan Old Style, Baskerville, "Times New Roman", "Songti SC", serif; font-size: 48px; font-weight: 500; }
    .faq details { border-top: 1px solid var(--line); }
    .faq details:last-child { border-bottom: 1px solid var(--line); }
    .faq summary { cursor: pointer; padding: 20px 4px; font-weight: 700; }
    .faq p { margin: -4px 4px 22px; color: var(--muted); }

    .footer { padding: 40px 24px; color: #dcecff; background: #062e53; }
    .footer-inner { width: min(1180px, 100%); margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .footer-links { display: flex; gap: 20px; color: rgba(255,255,255,.7); font-size: 13px; }

    @media (max-width: 980px) {
      .nav-links a:not(.nav-download) { display: none; }
      .hero { min-height: 790px; }
      .feature-split, .feature-split.reverse, .download-inner { grid-template-columns: 1fr; }
      .feature-split.reverse .feature-copy, .feature-split.reverse .feature-visual { order: initial; }
      .workflow-grid { grid-template-columns: repeat(2, 1fr); }
      .trust-grid { grid-template-columns: 1fr; }
      .trust-item:nth-child(2) { border-right: 0; }
      .trust-item:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .all-downloads { grid-template-columns: repeat(2, 1fr); }
      .all-downloads a:nth-child(3n) { border-right: 1px solid rgba(255,255,255,.13); }
      .all-downloads a:nth-child(2n) { border-right: 0; }
      .all-downloads a:nth-last-child(-n+3) { border-bottom: 1px solid rgba(255,255,255,.13); }
      .all-downloads a:nth-last-child(-n+2) { border-bottom: 0; }
    }

    @media (max-width: 640px) {
      .site-header { height: 66px; }
      .nav { width: min(100% - 28px, 1240px); }
      .brand { font-size: 18px; }
      .nav-download { padding: 8px 12px; font-size: 13px; }
      .hero { min-height: 710px; padding: 116px 16px 0; }
      .hero h1 { font-size: 52px; }
      .hero-lede { font-size: 16px; }
      .hero-actions { flex-direction: column; align-items: stretch; }
      .product-shot { width: calc(100% - 20px); margin-top: 40px; padding: 5px; border-radius: 13px 13px 0 0; }
      .window-bar { height: 23px; }
      .window-dot { width: 7px; height: 7px; }
      .section { width: min(100% - 30px, 1180px); padding: 78px 0; }
      .section h2, .feature-copy h2 { font-size: 40px; }
      .feature-split { gap: 36px; }
      .workflow-grid { grid-template-columns: 1fr; }
      .workflow-card { min-height: 190px; }
      .trust-grid { width: 100%; grid-template-columns: 1fr; }
      .trust-item { border-right: 0; border-bottom: 1px solid var(--line); }
      .download-section { width: calc(100% - 24px); margin-bottom: 80px; border-radius: 22px; }
      .download-inner { padding: 38px 24px; gap: 32px; }
      .all-downloads { grid-template-columns: 1fr; }
      .all-downloads a { border-right: 0; border-bottom: 1px solid rgba(255,255,255,.13); }
      .advanced { width: calc(100% - 24px); }
      .advanced-card summary { align-items: flex-start; flex-direction: column; }
      .command-box { align-items: flex-start; flex-direction: column; }
      .footer-inner { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <nav class="nav" aria-label="主导航">
      <a class="brand" href="#top">
        <img class="brand-mark" src="icon.png?v=${DESKTOP_VERSION}" alt="" />
        <span>AgentCLI</span>
      </a>
      <div class="nav-links">
        <a href="#product">能做什么</a>
        <a href="#workflow">使用步骤</a>
        <a href="#faq">常见问题</a>
        <a class="nav-download" href="#download">下载 AgentCLI</a>
      </div>
    </nav>
  </header>

  <main id="top">
    <section class="hero">
      <div class="hero-inner">
        <span class="eyebrow"><span class="eyebrow-dot"></span> AgentCLI 桌面版 · v${DESKTOP_VERSION}</span>
        <h1>把任务交给 AI 助手，<br />在一个地方查看进度和结果。</h1>
        <p class="hero-lede">写下要做的事，附上相关资料，再选择一个助手或一支小队。任务完成后可以直接查看结果，需要调整时就在原任务里继续回复。</p>
        <div class="hero-actions">
          <a id="heroDownload" class="button button-primary" href="${DOWNLOADS.macArm.href}"><span aria-hidden="true">↓</span><span id="heroDownloadText">下载 AgentCLI</span></a>
          <a class="button button-secondary" href="#workflow">查看使用方式 <span aria-hidden="true">→</span></a>
        </div>
        <div id="heroDownloadContext" class="download-context">正在查看适合你电脑的版本…</div>
        <div class="works-with">
          <span>可使用</span>
          <strong>Claude Code</strong><span class="runtime-dot">•</span>
          <strong>Codex</strong><span class="runtime-dot">•</span>
          <strong>内置 Pi 执行器</strong>
        </div>
      </div>
      <div class="product-shot" aria-label="AgentCLI 工作台预览">
        <div class="window-bar"><span class="window-dot red"></span><span class="window-dot yellow"></span><span class="window-dot green"></span></div>
        <img src="images/workbench-inbox.png" alt="AgentCLI 收件箱与任务交付界面" />
      </div>
    </section>

    <section class="trust-strip" aria-label="产品特点">
      <div class="trust-grid">
        <div class="trust-item"><strong>下载后按系统提示安装</strong><span>当前测试版尚未完成商业代码签名，安装时请确认系统安全提示</span></div>
        <div class="trust-item"><strong>任务资料默认保存在本机</strong><span>任务记录、参考文件和完成结果都留在这台电脑上</span></div>
        <div class="trust-item"><strong>修改不用重新开始</strong><span>在原任务里补充要求，之前的资料和结果都会保留</span></div>
      </div>
    </section>

    <section id="product" class="section feature-split">
      <div class="feature-copy">
        <span class="section-kicker">单个 AI 助手</span>
        <h2>日常任务，交给一个助手处理。</h2>
        <p class="section-intro">写下目标，附上图片、文档或压缩包。助手开始处理后，你可以在收件箱查看进度，完成结果也会集中出现在这里。</p>
        <div class="feature-points">
          <div class="feature-point"><span class="feature-icon">1</span><div><strong>直接说明你要什么</strong><p>用日常语言写清目标、格式和需要注意的事项。</p></div></div>
          <div class="feature-point"><span class="feature-icon">2</span><div><strong>资料跟着任务走</strong><p>参考文件、补充说明和完成结果都放在同一项任务里。</p></div></div>
          <div class="feature-point"><span class="feature-icon">3</span><div><strong>需要修改，直接回复</strong><p>指出要调整的地方，助手会接着原任务继续处理。</p></div></div>
        </div>
      </div>
      <div class="feature-visual"><img src="images/workbench-tasks.png" alt="AgentCLI 任务管理页面" loading="lazy" /></div>
    </section>

    <section class="section feature-split reverse">
      <div class="feature-copy">
        <span class="section-kicker">小队协作</span>
        <h2>内容较多时，让几位助手分头处理。</h2>
        <p class="section-intro">适合需要查资料、整理、写作和检查一起进行的任务。小队会先确定分工，再由一位负责人汇总结果。</p>
        <div class="feature-points">
          <div class="feature-point"><span class="feature-icon">✓</span><div><strong>先确定分工</strong><p>每位助手负责清楚的一部分，减少重复处理。</p></div></div>
          <div class="feature-point"><span class="feature-icon">↗</span><div><strong>可以同时推进</strong><p>查找、整理、写作和检查可以分别进行。</p></div></div>
          <div class="feature-point"><span class="feature-icon">◎</span><div><strong>最后只看一份结果</strong><p>负责人汇总各部分，并标出需要你确认的内容。</p></div></div>
        </div>
      </div>
      <div class="feature-visual"><img src="images/workbench-agents.png" alt="AgentCLI 智能体与小队界面" loading="lazy" /></div>
    </section>

    <section id="workflow" class="section workflow-section">
      <div class="workflow-head">
        <span class="section-kicker">使用步骤</span>
        <h2>四步完成一次任务。</h2>
        <p class="section-intro">从提交要求到确认结果，都在同一项任务里进行。</p>
      </div>
      <div class="workflow-grid">
        <article class="workflow-card"><div class="workflow-number">01</div><h3>说明任务</h3><p>写下目标和要求，并添加相关图片或文档。</p></article>
        <article class="workflow-card"><div class="workflow-number">02</div><h3>选择助手</h3><p>简单任务选择一个助手，内容较多时可以选择小队。</p></article>
        <article class="workflow-card"><div class="workflow-number">03</div><h3>查看结果</h3><p>完成后会在收件箱提醒你，报告、图片和附件可以直接打开。</p></article>
        <article class="workflow-card"><div class="workflow-number">04</div><h3>确认或修改</h3><p>满意就保存结果；需要调整，就在原任务里补充要求。</p></article>
      </div>
    </section>

    <section id="download" class="download-section">
      <div class="download-inner">
        <div class="download-copy">
          <span class="section-kicker" style="color:#a9ead9">下载 AgentCLI</span>
          <h2>选择与你的电脑相符的版本。</h2>
          <p>页面会先显示一个建议版本。下载前，请再确认你的电脑系统和芯片类型。</p>
          <p>安装后即可打开工作台；首次执行任务前，请登录 Claude Code、Codex，或为随客户端提供的 Pi 执行器配置可用的模型服务。</p>
        </div>
        <div class="download-card">
          <div class="detected-label">建议版本</div>
          <h3 id="recommendedTitle">macOS 客户端</h3>
          <div id="recommendedDetail" class="download-detail">Apple Silicon · DMG · 211 MB</div>
          <a id="recommendedDownload" class="button button-primary" href="${DOWNLOADS.macArm.href}">下载 macOS 客户端</a>
          <select id="platformSelect" class="platform-select" aria-label="选择其他系统版本">
            <option value="macArm">macOS Apple Silicon</option>
            <option value="macIntel">macOS Intel</option>
            <option value="windows">Windows x64</option>
            <option value="windowsArm">Windows ARM64</option>
            <option value="linux">Linux x64</option>
            <option value="linuxArm">Linux ARM64</option>
          </select>
          <p id="downloadNote" class="download-note">下载后打开 DMG，将 AgentCLI 拖入“应用程序”。当前 macOS 构建尚未经过 Apple 公证；若首次打开被拦截，请在“应用程序”中右键 AgentCLI，选择“打开”并再次确认。无需关闭系统安全保护。</p>
        </div>
      </div>
      <div class="all-downloads">
        <a href="${DOWNLOADS.macArm.href}"><strong>macOS Apple Silicon</strong><span>DMG 桌面客户端</span></a>
        <a href="${DOWNLOADS.macIntel.href}"><strong>macOS Intel</strong><span>DMG 桌面客户端</span></a>
        <a href="${DOWNLOADS.windows.href}"><strong>Windows x64</strong><span>安装程序</span></a>
        <a href="${DOWNLOADS.windowsArm.href}"><strong>Windows ARM64</strong><span>安装程序</span></a>
        <a href="${DOWNLOADS.linux.href}"><strong>Linux x64</strong><span>AppImage</span></a>
        <a href="${DOWNLOADS.linuxArm.href}"><strong>Linux ARM64</strong><span>AppImage</span></a>
      </div>
    </section>

    <section id="advanced" class="advanced">
      <details class="advanced-card">
        <summary>
          <strong>高级用户与命令行</strong>
          <span>查看内置 CLI、传统安装方式和常用命令 ＋</span>
        </summary>
        <div class="advanced-body">
          <h3>安装 App 后可以使用 CLI 吗？</h3>
          <p>可以。客户端本身已经内置 AgentCLI，首次启动后会创建 <code>~/.hermit/bin/agentcli</code>，App 和终端共用同一份任务与配置数据，不需要再次执行 npm 安装。</p>
          <div class="command-box"><code>~/.hermit/bin/agentcli --version</code><button class="copy-button" data-copy="~/.hermit/bin/agentcli --version">复制</button></div>
          <p><strong>直接输入 <code>agentcli</code>：</strong>客户端首次启动会在现有 PATH 中寻找可写的标准命令目录，并安全创建指向内置 CLI 的命令链接；不会覆盖同名用户命令，也不会修改 Shell 配置。若系统目录不可写，仍可使用上面的完整路径。</p>

          <h3>不安装桌面 App</h3>
          <p>传统 CLI 安装只推荐给需要脚本化或服务器环境的高级用户。</p>
          <div class="command-box"><code>curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/yancyuu/agentcli/master/scripts/install.sh | bash</code><button class="copy-button" data-copy="curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/yancyuu/agentcli/master/scripts/install.sh | bash">复制</button></div>
          <div class="command-box"><code>npm install -g @yancyyu/agentcli</code><button class="copy-button" data-copy="npm install -g @yancyyu/agentcli">复制</button></div>

          <h3>常用命令</h3>
          <ul>
            <li><code>agentcli --version</code>：查看当前版本。</li>
            <li><code>agentcli tasks list --team &lt;team&gt;</code>：查看团队任务。</li>
            <li><code>agentcli doctor</code>：执行只读诊断。</li>
            <li><code>agentcli usage status</code>：查看用量采集状态。</li>
          </ul>
          <p><a href="https://github.com/yancyuu/agentcli">在 GitHub 查看完整说明 →</a></p>
        </div>
      </details>
    </section>

    <section id="faq" class="faq">
      <h2>常见问题</h2>
      <details open><summary>我不会编程，可以使用吗？</summary><p>可以。你只需要说明想要什么结果，并提供相关资料。创建任务、查看进度和提出修改都可以在桌面界面中完成。</p></details>
      <details><summary>我的任务和文件保存在哪里？</summary><p>任务记录和文件默认保存在这台电脑上。使用外部 AI 服务处理任务时，完成任务所需的文字、文件或必要上下文可能会发送给该服务，具体范围取决于你选择的服务和设置。AgentBus 数据上报需要另外连接并授权。</p></details>
      <details><summary>安装后还需要其他软件吗？</summary><p>一般不需要。安装 AgentCLI 后，按首次启动页面的提示完成设置即可。使用 Claude Code、Codex 或 Pi 时，仍需登录或配置相应的模型服务；Pi 是随客户端提供的执行器，不包含免费模型。</p></details>
      <details><summary>什么时候用一个助手，什么时候用小队？</summary><p>日常整理、写作或检查任务通常选择一个助手即可。需要同时查资料、整理内容、撰写和复核时，可以选择小队。</p></details>
      <details><summary>我应该下载哪个 Mac 版本？</summary><p>点击屏幕左上角的苹果菜单，选择“关于本机”。如果显示 Apple M 系列芯片，请选择 Apple 芯片版；如果显示 Intel 处理器，请选择 Intel 芯片版。当前测试版尚未经过 Apple 公证；若系统阻止首次打开，请在“应用程序”中右键 AgentCLI，选择“打开”并确认，不要关闭 Gatekeeper 或系统安全保护。</p></details>
      <details><summary>当前有哪些版本？</summary><p>目前提供 macOS Apple Silicon、macOS Intel、Windows x64、Windows ARM64、Linux x64 和 Linux ARM64 版本。Mac 使用 DMG，Windows 使用安装程序，Linux 使用 AppImage；请按系统和芯片类型选择。</p></details>
    </section>
  </main>

  <footer class="footer">
    <div class="footer-inner">
      <a class="brand" href="#top"><img class="brand-mark" src="icon.png?v=${DESKTOP_VERSION}" alt="" /><span>AgentCLI</span></a>
      <div class="footer-links"><a href="#download">下载</a><a href="#advanced">高级用户</a><a href="https://github.com/yancyuu/agentcli">GitHub</a><span>© 2026 AgentCLI</span></div>
    </div>
  </footer>

  <script>
    const DOWNLOADS = ${JSON.stringify(DOWNLOADS)};

    function updateDownload(key) {
      const item = DOWNLOADS[key] || DOWNLOADS.macArm;
      const isDesktop = item.kind === 'desktop';
      document.getElementById('recommendedTitle').textContent = item.label;
      document.getElementById('recommendedDetail').textContent = item.detail + ' · v${DESKTOP_VERSION}';
      document.getElementById('recommendedDownload').href = item.href;
      document.getElementById('recommendedDownload').textContent = '下载' + item.label;
      document.getElementById('platformSelect').value = key;
      document.getElementById('downloadNote').textContent = key === 'macArm' || key === 'macIntel'
        ? '下载后打开 DMG，将 AgentCLI 拖入“应用程序”。当前构建尚未经过 Apple 公证；若首次打开被拦截，请右键 AgentCLI，选择“打开”并确认，无需关闭系统安全保护。'
        : isDesktop
          ? '下载后打开安装文件，并按系统提示完成安装。当前测试版尚未完成商业代码签名，请核对下载来源与系统提示。'
          : '当前提供免 Node.js 的 ZIP 便携版；解压后按包内说明运行。';
      document.getElementById('heroDownload').href = item.href;
      document.getElementById('heroDownloadText').textContent = '下载' + item.label;
      document.getElementById('heroDownloadContext').textContent = '当前显示：' + item.shortLabel + ' · ' + item.detail + '。下载前请确认系统和芯片类型。';
    }

    function detectBasicPlatform() {
      const ua = navigator.userAgent.toLowerCase();
      const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
      const value = platform.toLowerCase();
      if (value.includes('win') || ua.includes('windows')) return 'windows';
      if (value.includes('linux') || ua.includes('linux')) return 'linux';
      if (value.includes('mac') || ua.includes('mac os')) return 'macArm';
      return 'macArm';
    }

    async function detectPlatform() {
      let key = detectBasicPlatform();
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        try {
          const values = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
          const architecture = String(values.architecture).toLowerCase();
          const isArm = architecture.includes('arm') || architecture.includes('aarch');
          if (key === 'macArm' && architecture.includes('x86')) key = 'macIntel';
          else if (key === 'windows' && isArm) key = 'windowsArm';
          else if (key === 'linux' && isArm) key = 'linuxArm';
        } catch (_) {
          // Safari does not expose CPU architecture. Modern macOS defaults to Apple Silicon.
        }
      }
      updateDownload(key);
    }

    document.getElementById('platformSelect').addEventListener('change', event => updateDownload(event.target.value));
    document.querySelectorAll('[data-copy]').forEach(button => {
      button.addEventListener('click', async () => {
        const original = button.textContent;
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          button.textContent = '已复制';
        } catch (_) {
          button.textContent = '请手动复制';
        }
        setTimeout(() => { button.textContent = original; }, 1400);
      });
    });
    detectPlatform();
  </script>
</body>
</html>`;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeText('index.html', html);
copyFile('scripts/install.sh', 'install.sh');
copyFile('scripts/install.ps1', 'install.ps1');
copyFile('public/icon.png', 'icon.png');
copyFile('docs/screenshots/agentcli/workbench/01-inbox.png', 'images/workbench-inbox.png');
copyFile('docs/screenshots/agentcli/workbench/03-tasks.png', 'images/workbench-tasks.png');
copyFile('docs/screenshots/agentcli/workbench/05-assistants.png', 'images/workbench-agents.png');

console.log(`Built GitHub Pages site at ${OUT_DIR}`);
console.log('- index.html');
console.log('- install.sh / install.ps1');
console.log('- icon.png');
console.log('- images/workbench-*.png');

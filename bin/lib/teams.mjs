// teams.mjs — local team metadata + tasks listing and `teams create`/`tasks list`
// commands. Reads manifests via settings.safeReadJson; renders via terminal.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rethrowIfExitSentinel } from './exitGuard.mjs';

import {
  hermitHome,
  jsonRequested,
  commandArgs,
  repoRoot,
  daemonPidPath,
  hermitBridgeConfigPath,
  findOptionValue,
  findOptionValues,
  findAnyOptionValue,
  findAnyOptionValues,
} from './env.mjs';
import { BRAND, brandLogPrefix } from '../branding.mjs';
import {
  askChoice,
  askRequired,
  createPromptInterface,
  isInteractiveCli,
  printCliRows,
  printJson,
} from './terminal.mjs';
import { safeReadJson } from './settings.mjs';
import { collectDaemonStatus } from './daemon.mjs';

function listDirectoryNames(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isSafeTeamArg(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]+$/.test(value) && !value.startsWith('-');
}

const KNOWN_HARNESSES = [
  'claudecode',
  'codex',
  'cursor',
  'gemini',
  'iflow',
  'kimi',
  'devin',
  'opencode',
  'qoder',
  'pi',
  'acp',
  'tmux',
];


function isValidBindProject(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function normalizeWorkDir(value) {
  const raw = String(value || '').trim().replace(/^～/, '~');
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function generateBindProject(displayName) {
  const normalized = String(displayName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (isValidBindProject(normalized)) return normalized;
  const hash = crypto.createHash('sha1').update(String(displayName || 'team')).digest('hex').slice(0, 8);
  return `team-${hash}`;
}

function isHiddenTeam(manifest) {
  const slug = String(manifest?.slug || '');
  const bindProject = String(manifest?.bindProject || '');
  return (
    Boolean(manifest?.deletedAt || manifest?.pendingDelete) ||
    ['default', 'my-project', 'system-manager'].includes(slug) ||
    slug.startsWith('feishu:') ||
    bindProject.startsWith('feishu:')
  );
}

function collectTeams() {
  const teamsDir = path.join(hermitHome, 'teams');
  const warnings = [];
  const teams = [];

  for (const slug of listDirectoryNames(teamsDir)) {
    const manifestPath = path.join(teamsDir, slug, 'team.json');
    if (!existsSync(manifestPath)) continue;
    const { value, error } = safeReadJson(manifestPath);
    if (error || !value || typeof value !== 'object') {
      warnings.push({ path: manifestPath, message: error || 'Invalid team manifest' });
      continue;
    }
    const manifest = { ...value, slug: value.slug || slug };
    if (isHiddenTeam(manifest)) continue;
    teams.push({
      slug: manifest.slug,
      displayName: manifest.displayName || manifest.name || manifest.slug,
      bindProject: manifest.bindProject || manifest.slug,
      harness: manifest.harness || manifest.agentType || null,
      workDir: manifest.workDir || null,
      description: manifest.description || '',
      createdAt: manifest.createdAt || null,
      updatedAt: manifest.updatedAt || null,
      pendingDelete: Boolean(manifest.pendingDelete),
      deletedAt: manifest.deletedAt || null,
      restartRequired: Boolean(manifest.restartRequired),
    });
  }

  teams.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  return { teams, warnings, teamsDir };
}

function resolveTeamSlug(teamArg, teams) {
  if (!isSafeTeamArg(teamArg)) return null;
  const directPath = path.join(hermitHome, 'teams', teamArg, 'team.json');
  if (existsSync(directPath)) return teamArg;
  return teams.find((team) => team.bindProject === teamArg || team.slug === teamArg)?.slug || teamArg;
}

function mapTaskStatus(status) {
  if (status === 'doing') return 'in_progress';
  if (status === 'done') return 'completed';
  return 'pending';
}

function collectTasks(teamArg) {
  const { teams, warnings } = collectTeams();
  const resolvedTeam = resolveTeamSlug(teamArg, teams);
  if (!resolvedTeam) {
    return {
      team: teamArg,
      resolvedTeam: null,
      tasks: [],
      warnings: [...warnings, { path: '', message: 'Invalid team argument' }],
      boardPath: null,
    };
  }
  const boardPath = path.join(hermitHome, 'teams', resolvedTeam, 'tasks', 'board.json');
  if (!existsSync(boardPath)) return { team: teamArg, resolvedTeam, tasks: [], warnings, boardPath };

  const { value, error } = safeReadJson(boardPath);
  if (error || !value || typeof value !== 'object') {
    return {
      team: teamArg,
      resolvedTeam,
      tasks: [],
      warnings: [...warnings, { path: boardPath, message: error || 'Invalid task board' }],
      boardPath,
    };
  }

  const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
  const tasks = rawTasks
    .filter((task) => task && !task.deletedAt)
    .map((task) => {
      const deliveries = Array.isArray(task.deliveries) ? task.deliveries : [];
      const latestDelivery = deliveries.length > 0 ? deliveries[deliveries.length - 1] : null;
      return {
        id: task.id,
        displayId: typeof task.id === 'string' ? task.id.slice(0, 8) : '',
        subject: task.title || task.subject || '',
        description: task.description || '',
        status: mapTaskStatus(task.status),
        owner: task.assignee || task.owner || null,
        createdAt: task.createdAt || null,
        updatedAt: task.updatedAt || null,
        result: latestDelivery?.result || null,
        dispatchMeta: task.dispatchMeta || null,
      };
    });

  return { team: teamArg, resolvedTeam, tasks, warnings, boardPath };
}

async function printDoctor({ exitOnDone = true } = {}) {
  const status = await collectDaemonStatus();
  const checks = [
    { id: 'hermit-home', ok: existsSync(hermitHome), label: `${BRAND.productName} home`, path: hermitHome },
    { id: 'teams-dir', ok: existsSync(path.join(hermitHome, 'teams')), label: 'Teams directory', path: path.join(hermitHome, 'teams') },
    { id: 'daemon-pid', ok: status.pidfilePresent ? Boolean(status.pid) : true, label: 'Daemon pidfile', path: daemonPidPath },
    { id: 'server', ok: status.server.running, label: `${BRAND.stylizedName} HTTP server`, url: status.url },
    { id: 'bridge-config', ok: existsSync(hermitBridgeConfigPath), label: `${BRAND.runtimeBridgeName} config`, path: hermitBridgeConfigPath },
    { id: 'claude-projects', ok: existsSync(path.join(os.homedir(), '.claude', 'projects')), label: 'Claude Code projects', path: path.join(os.homedir(), '.claude', 'projects') },
  ];
  const result = { ok: checks.every((check) => check.ok), command: 'doctor', status, checks };

  if (jsonRequested) printJson(result, result.ok ? 0 : 1);

  console.log(`${BRAND.stylizedName} doctor`);
  for (const check of checks) {
    const target = check.path || check.url || '';
    console.log(`${check.ok ? 'OK' : 'ERR'} ${check.label}${target ? `: ${target}` : ''}`);
  }
  if (exitOnDone) process.exit(result.ok ? 0 : 1);
  return result;
}

function printTeamsList({ exitOnDone = true } = {}) {
  const result = { ok: true, command: 'teams list', hermitHome, ...collectTeams() };
  if (jsonRequested) printJson(result);

  if (result.teams.length === 0) {
    printCliRows('本地团队', [
      ['数量', '0'],
      ['路径', result.teamsDir],
    ], '创建团队可运行：agentcli teams create');
  } else {
    printCliRows('本地团队', [
      ['数量', `${result.teams.length} 个可见团队`],
      ['路径', result.teamsDir],
    ], '已删除或待删除的团队不会显示在这里。');
    for (const team of result.teams) {
      const harness = team.harness ? ` (${team.harness})` : '';
      console.log(`  ${team.slug}${harness} - ${team.displayName}`);
    }
  }
  for (const warning of result.warnings) {
    console.error(`${brandLogPrefix()} 警告：${warning.path}: ${warning.message}`);
  }
  if (exitOnDone) process.exit(0);
  return result;
}
function buildTeamCreateSeed() {
  const displayName = findAnyOptionValue(['--name', '--display-name']) || commandArgs[2] || '';
  return {
    displayName,
    bindProject: findOptionValue('--bind-project') || '',
    workDir: findAnyOptionValue(['--work-dir', '--cwd']) || '',
    harness: findOptionValue('--harness') || 'claudecode',
  };
}

async function promptForMissingTeamCreateFields(seed) {
  if (!isInteractiveCli()) return seed;

  const rl = createPromptInterface();
  try {
    const displayName = seed.displayName || (await askRequired(rl, '团队名称'));
    const bindProjectDefault = seed.bindProject || generateBindProject(displayName);
    const bindProject = seed.bindProject || (await askRequired(rl, '团队 ID / bindProject', bindProjectDefault));
    const workDir = seed.workDir || (await askRequired(rl, '工作目录', process.cwd()));
    const harness = seed.harness && KNOWN_HARNESSES.includes(seed.harness)
      ? seed.harness
      : await askChoice(rl, '选择运行时', KNOWN_HARNESSES, 'claudecode');
    return { displayName, bindProject, workDir, harness };
  } finally {
    rl.close();
  }
}

function failTeamCreate(error) {
  const payload = { ok: false, command: 'teams create', error };
  if (jsonRequested) printJson(payload, 1);
  console.error(`${brandLogPrefix()} ${error}`);
  process.exit(1);
}

function createLocalTeam(input) {
  const displayName = String(input.displayName || '').trim();
  const bindProject = String(input.bindProject || '').trim();
  const harness = String(input.harness || 'claudecode').trim();
  const workDir = normalizeWorkDir(input.workDir);

  if (!displayName) throw new Error('Missing required --name <name>');
  if (!bindProject) throw new Error('Missing required --bind-project <id>');
  if (!isValidBindProject(bindProject)) {
    throw new Error('bindProject must match ^[a-z0-9][a-z0-9_-]*$');
  }
  if (!workDir) throw new Error('Missing required --work-dir <path>');
  if (!KNOWN_HARNESSES.includes(harness)) {
    throw new Error(`Unsupported harness: ${harness}`);
  }

  const teamsDir = path.join(hermitHome, 'teams');
  const rootPath = path.join(teamsDir, bindProject);
  const existing = collectTeams().teams.find((team) => team.bindProject === bindProject || team.slug === bindProject);
  if (existing || existsSync(path.join(rootPath, 'team.json'))) {
    throw new Error(`Team bindProject already exists: ${bindProject}`);
  }

  mkdirSync(path.join(rootPath, 'messages'), { recursive: true });
  mkdirSync(path.join(rootPath, 'tasks'), { recursive: true });
  const createdAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    slug: bindProject,
    displayName,
    bindProject,
    harness,
    workDir,
    collaboration: true,
    rootPath,
    createdAt,
  };
  writeFileSync(path.join(rootPath, 'team.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifest;
}

async function printTeamsCreate({ exitOnDone = true } = {}) {
  try {
    const input = await promptForMissingTeamCreateFields(buildTeamCreateSeed());
    const team = createLocalTeam(input);
    const result = { ok: true, command: 'teams create', hermitHome, team };
    if (jsonRequested) printJson(result);

    printCliRows('团队已创建', [
      ['团队', `${team.slug} - ${team.displayName}`],
      ['运行时', team.harness],
      ['工作目录', team.workDir],
    ], '下一步：agentcli teams list');
    if (exitOnDone) process.exit(0);
    return result;
  } catch (err) {
    rethrowIfExitSentinel(err);
    if (!exitOnDone) throw err;
    failTeamCreate(err instanceof Error ? err.message : String(err));
  }
}

function printTasksList({ exitOnDone = true } = {}) {
  const teamArg = findOptionValue('--team') || commandArgs[2];
  if (!teamArg) {
    const payload = { ok: false, command: 'tasks list', error: 'Missing required --team <team>' };
    if (jsonRequested) printJson(payload, 1);
    console.error(`${brandLogPrefix()} 用法：agentcli tasks list --team <team>`);
    if (exitOnDone) process.exit(1);
    return payload;
  }

  const result = { ok: true, command: 'tasks list', hermitHome, ...collectTasks(teamArg) };
  if (jsonRequested) printJson(result);

  if (result.tasks.length === 0) {
    console.log(`${result.resolvedTeam} 没有活跃任务。`);
  } else {
    for (const task of result.tasks) {
      console.log(`${task.displayId || task.id} [${task.status}] ${task.subject}`);
    }
  }
  for (const warning of result.warnings) {
    console.error(`${brandLogPrefix()} 警告：${warning.path}: ${warning.message}`);
  }
  if (exitOnDone) process.exit(0);
  return result;
}

export {
listDirectoryNames,
isSafeTeamArg,
isValidBindProject,
normalizeWorkDir,
generateBindProject,
isHiddenTeam,
collectTeams,
resolveTeamSlug,
mapTaskStatus,
collectTasks,
printDoctor,
printTeamsList,
buildTeamCreateSeed,
promptForMissingTeamCreateFields,
failTeamCreate,
createLocalTeam,
printTeamsCreate,
printTasksList,
};

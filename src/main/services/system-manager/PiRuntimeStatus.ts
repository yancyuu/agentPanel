/**
 * Pi 运行时可用性探测（诊断功能的执行前置）。
 *
 * 真实探测两项：
 * - binary：~/.hermit/bin/pi（桌面内置 shim）或 PATH 上的 pi 可执行文件；
 * - 配置就绪：~/.pi/agent/auth.json 存在且为有效配置（pi 的登录态）。
 *
 * 结果带 TTL 缓存（30s），UI 轮询/前置拦截共用；失败场景后可强制刷新。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface PiRuntimeStatus {
  available: boolean;
  binaryReady: boolean;
  authReady: boolean;
  binaryPath?: string;
  /** 缺失项的简体中文描述（用于引导文案） */
  missing: string[];
  checkedAt: string;
}

export interface PiRuntimeProbeOptions {
  hermitHome?: string;
  piHome?: string;
  /** 可注入的 PATH 探测（测试用） */
  resolveFromPath?: (command: string) => Promise<string | null>;
}

const CACHE_TTL_MS = 30_000;

let cache: { status: PiRuntimeStatus; at: number } | null = null;

function defaultHermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

function defaultResolveFromPath(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where' : 'which',
      [command],
      { timeout: 5_000 },
      (error, stdout) => resolve(error || !stdout.trim() ? null : stdout.trim().split(/\r?\n/u)[0])
    );
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readPiAuthReady(piHome: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(piHome, 'agent', 'auth.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
  } catch {
    return false;
  }
}

export async function probePiRuntime(
  options: PiRuntimeProbeOptions = {}
): Promise<PiRuntimeStatus> {
  const hermitHome = options.hermitHome ?? defaultHermitHome();
  const piHome = options.piHome ?? path.join(os.homedir(), '.pi');
  const resolveFromPath = options.resolveFromPath ?? defaultResolveFromPath;

  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const bundled = path.join(hermitHome, 'bin', `pi${suffix}`);
  let binaryPath: string | undefined;
  if (await pathExists(bundled)) {
    binaryPath = bundled;
  } else {
    binaryPath = (await resolveFromPath('pi')) ?? undefined;
  }

  const binaryReady = Boolean(binaryPath);
  const authReady = await readPiAuthReady(piHome);
  const missing: string[] = [];
  if (!binaryReady) missing.push('未找到 Pi 命令行');
  if (!authReady) missing.push('Pi 未登录配置（缺少 ~/.pi/agent/auth.json）');

  return {
    available: binaryReady && authReady,
    binaryReady,
    authReady,
    ...(binaryPath ? { binaryPath } : {}),
    missing,
    checkedAt: new Date().toISOString(),
  };
}

export async function getPiRuntimeStatus(
  options: PiRuntimeProbeOptions = {}
): Promise<PiRuntimeStatus> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;
  const status = await probePiRuntime(options);
  cache = { status, at: Date.now() };
  return status;
}

export async function refreshPiRuntimeStatus(
  options: PiRuntimeProbeOptions = {}
): Promise<PiRuntimeStatus> {
  cache = null;
  return getPiRuntimeStatus(options);
}

/** Test-only: reset the TTL cache between unit tests. */
export function __resetPiRuntimeStatusCache(): void {
  cache = null;
}

/**
 * OpenSpec CLI 运行时封装：vendor 定位 + agent 可调用的命令入口。
 *
 * 调用形态：`<内置 node> <vendor>/openspec/bin/openspec.js <args>`。
 * standalone 包用包内 node（process.execPath 即内置 node），dev 用当前 node；
 * 对 agent 会话暴露 `~/.hermit/bin/openspec` 包装脚本（附带 Windows .cmd），
 * 用户机器无需预装 Node.js 或 npm。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('openspec-runtime');

export function resolveHermitHome(): string {
  return process.env.HERMIT_HOME || path.join(os.homedir(), '.hermit');
}

/** 解析 vendor 的 openspec CLI 入口文件；找不到（未 vendor）时返回 null */
export function resolveOpenspecCliEntry(): string | null {
  const explicit = process.env.AGENTPANEL_OPENSPEC_CLI?.trim();
  const candidates = [
    explicit || null,
    process.env.AGENTPANEL_PACKAGE_ROOT?.trim()
      ? path.join(
          process.env.AGENTPANEL_PACKAGE_ROOT.trim(),
          'vendor',
          'openspec',
          'bin',
          'openspec.js'
        )
      : null,
    // dev：仓库内 vendor（本文件位于 src/main/services/team-management/）
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../vendor/openspec/bin/openspec.js'
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 在 hermitHome/bin 写入 openspec 包装脚本（幂等，内容漂移即重写）。
 * 返回 agent 指令里可直接引用的命令路径；vendor 缺失时返回 null。
 */
export function ensureOpenspecWrapperCommand(hermitHome: string): string | null {
  const cliEntry = resolveOpenspecCliEntry();
  if (!cliEntry) {
    logger.warn('openspec vendor CLI not found; wrapper not installed');
    return null;
  }
  const binDir = path.join(hermitHome, 'bin');
  const wrapperPath = path.join(binDir, 'openspec');
  const nodeBin = process.execPath;
  const shContent = `#!/bin/sh\nexec "${nodeBin}" "${cliEntry}" "$@"\n`;
  const cmdContent = `@echo off\r\n"${nodeBin}" "${cliEntry}" %*\r\n`;

  try {
    fs.mkdirSync(binDir, { recursive: true });
    const current = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath, 'utf8') : '';
    if (current !== shContent) {
      fs.writeFileSync(wrapperPath, shContent, { mode: 0o755 });
    } else if (process.platform !== 'win32') {
      // Windows 无 chmod；且仅当内容未漂移（可能是旧版本写入丢了执行位）时才补
      execFileSync('chmod', ['+x', wrapperPath], { stdio: 'pipe' });
    }
    const cmdPath = `${wrapperPath}.cmd`;
    const currentCmd = fs.existsSync(cmdPath) ? fs.readFileSync(cmdPath, 'utf8') : '';
    if (currentCmd !== cmdContent) {
      fs.writeFileSync(cmdPath, cmdContent);
    }
    return wrapperPath;
  } catch (error) {
    logger.warn(
      `openspec wrapper install failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

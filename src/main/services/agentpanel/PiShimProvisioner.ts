import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PiShimProvisionOptions {
  hermitHome: string;
  packageRoot: string;
  version: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

export interface PiShimProvisionResult {
  status: 'created' | 'updated' | 'unchanged';
  targetPath: string;
  sourceEntry: string;
}

interface PiShimMarker {
  managedBy: 'agentpanel-desktop';
  commandName: 'pi';
  targetPath: string;
  sourceEntry: string;
  nodeExecutable: string;
  version: string;
}

function quoteShell(value: string): string {
  const escaped = value.replaceAll("'", `'"'"'`);
  return `'${escaped}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildShimContent(
  platform: NodeJS.Platform,
  nodeExecutable: string,
  sourceEntry: string
): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `${quoteCmd(nodeExecutable)} ${quoteCmd(sourceEntry)} %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec ${quoteShell(nodeExecutable)} ${quoteShell(sourceEntry)} "$@"`,
    '',
  ].join('\n');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(markerPath: string): Promise<PiShimMarker | null> {
  try {
    const value: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const marker = value as Partial<PiShimMarker>;
    return marker.managedBy === 'agentpanel-desktop' && marker.commandName === 'pi'
      ? (marker as PiShimMarker)
      : null;
  } catch {
    return null;
  }
}

async function writeAtomic(targetPath: string, content: string, mode?: number): Promise<void> {
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    if (mode !== undefined) await chmod(temporary, mode);
    try {
      await rename(temporary, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await rm(targetPath, { force: true });
      await rename(temporary, targetPath);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function provisionPiShim(
  options: PiShimProvisionOptions
): Promise<PiShimProvisionResult> {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const sourceEntry = path.join(
    options.packageRoot,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js'
  );
  await access(sourceEntry, fsConstants.R_OK);

  const binDir = path.join(options.hermitHome, 'bin');
  const targetPath = path.join(binDir, platform === 'win32' ? 'pi.cmd' : 'pi');
  const markerPath = path.join(binDir, 'pi.agentpanel-desktop.json');
  await mkdir(binDir, { recursive: true });

  const marker = await readMarker(markerPath);
  if ((await pathExists(targetPath)) && marker?.targetPath !== targetPath) {
    throw new Error(`Pi shim conflict: ${targetPath}`);
  }

  const content = buildShimContent(platform, nodeExecutable, sourceEntry);
  const nextMarker: PiShimMarker = {
    managedBy: 'agentpanel-desktop',
    commandName: 'pi',
    targetPath,
    sourceEntry,
    nodeExecutable,
    version: options.version,
  };
  const markerContent = `${JSON.stringify(nextMarker, null, 2)}\n`;
  const previousContent = await readFile(targetPath, 'utf8').catch(() => null);
  const previousMarker = await readFile(markerPath, 'utf8').catch(() => null);
  const status: PiShimProvisionResult['status'] =
    previousContent === null
      ? 'created'
      : previousContent === content && previousMarker === markerContent
        ? 'unchanged'
        : 'updated';

  if (status !== 'unchanged') {
    await writeAtomic(targetPath, content, platform === 'win32' ? undefined : 0o755);
    await writeAtomic(markerPath, markerContent, platform === 'win32' ? undefined : 0o600);
  }
  return { status, targetPath, sourceEntry };
}

import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentCliShimProvisionOptions {
  hermitHome: string;
  packageRoot: string;
  version: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

export interface AgentCliShimProvisionResult {
  status: 'created' | 'updated' | 'unchanged';
  commandName: 'agentcli' | 'agentcli-workbench';
  binDir: string;
  targetPath: string;
  sourceEntry: string;
}

interface AgentCliShimMarker {
  managedBy: 'hermit-workbench';
  commandName: AgentCliShimProvisionResult['commandName'];
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

function buildShimContent({
  platform,
  nodeExecutable,
  sourceEntry,
}: {
  platform: NodeJS.Platform;
  nodeExecutable: string;
  sourceEntry: string;
}): string {
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

async function readMarker(markerPath: string): Promise<AgentCliShimMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const marker = parsed as Partial<AgentCliShimMarker>;
    return marker.managedBy === 'hermit-workbench' ? (marker as AgentCliShimMarker) : null;
  } catch {
    return null;
  }
}

async function writeAtomic(targetPath: string, content: string, mode?: number): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    if (mode !== undefined) await chmod(tempPath, mode);
    try {
      await rename(tempPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await rm(targetPath, { force: true });
      await rename(tempPath, targetPath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function provisionAgentCliShim(
  options: AgentCliShimProvisionOptions
): Promise<AgentCliShimProvisionResult> {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const sourceEntry = path.join(options.packageRoot, 'bin', 'hermit.mjs');
  await access(sourceEntry, fsConstants.R_OK);

  const binDir = path.join(options.hermitHome, 'bin');
  await mkdir(binDir, { recursive: true });

  let commandName: AgentCliShimProvisionResult['commandName'] = 'agentcli';
  let targetPath = path.join(binDir, platform === 'win32' ? 'agentcli.cmd' : 'agentcli');
  let markerPath = path.join(binDir, 'agentcli.workbench.json');
  const primaryMarker = await readMarker(markerPath);
  if ((await pathExists(targetPath)) && primaryMarker?.targetPath !== targetPath) {
    commandName = 'agentcli-workbench';
    targetPath = path.join(
      binDir,
      platform === 'win32' ? 'agentcli-workbench.cmd' : 'agentcli-workbench'
    );
    markerPath = path.join(binDir, 'agentcli-workbench.workbench.json');
    const fallbackMarker = await readMarker(markerPath);
    if ((await pathExists(targetPath)) && fallbackMarker?.targetPath !== targetPath) {
      throw new Error(`AgentCli shim conflict: ${targetPath}`);
    }
  }

  const content = buildShimContent({ platform, nodeExecutable, sourceEntry });
  const marker: AgentCliShimMarker = {
    managedBy: 'hermit-workbench',
    commandName,
    targetPath,
    sourceEntry,
    nodeExecutable,
    version: options.version,
  };
  const markerContent = `${JSON.stringify(marker, null, 2)}\n`;
  const previousContent = await readFile(targetPath, 'utf8').catch(() => null);
  const previousMarker = await readFile(markerPath, 'utf8').catch(() => null);
  const status: AgentCliShimProvisionResult['status'] =
    previousContent === null
      ? 'created'
      : previousContent === content && previousMarker === markerContent
        ? 'unchanged'
        : 'updated';

  if (status !== 'unchanged') {
    await writeAtomic(targetPath, content, platform === 'win32' ? undefined : 0o755);
    await writeAtomic(markerPath, markerContent, platform === 'win32' ? undefined : 0o600);
  }

  return { status, commandName, binDir, targetPath, sourceEntry };
}

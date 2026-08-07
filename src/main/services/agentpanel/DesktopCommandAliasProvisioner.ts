import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface DesktopCommandAliasResult {
  command: 'agentpanel' | 'pi';
  status: 'created' | 'unchanged' | 'conflict' | 'unavailable';
  aliasPath?: string;
  targetPath: string;
}

export interface DesktopCommandAliasOptions {
  hermitHome: string;
  platform?: NodeJS.Platform;
  candidateDirs?: string[];
}

function defaultCandidateDirs(platform: NodeJS.Platform): string[] {
  const home = os.homedir();
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    const windowsApps = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
      : '';
    return windowsApps &&
      pathEntries.some((entry) => entry.toLowerCase() === windowsApps.toLowerCase())
      ? [windowsApps]
      : [];
  }
  const preferred = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, 'bin'),
    path.join(home, '.local', 'bin'),
  ];
  return preferred.filter((candidate) => pathEntries.includes(candidate));
}

async function writableDirectory(directory: string): Promise<boolean> {
  try {
    await access(directory, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function provisionAlias(
  command: DesktopCommandAliasResult['command'],
  targetPath: string,
  directory: string,
  platform: NodeJS.Platform
): Promise<DesktopCommandAliasResult> {
  const aliasPath = path.join(directory, `${command}${platform === 'win32' ? '.cmd' : ''}`);
  if (platform === 'win32') {
    const content = `@echo off\r\ncall "${targetPath.replaceAll('"', '""')}" %*\r\n`;
    try {
      const previous = await readFile(aliasPath, 'utf8');
      return {
        command,
        status: previous === content ? 'unchanged' : 'conflict',
        aliasPath,
        targetPath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { command, status: 'unavailable', aliasPath, targetPath };
      }
    }
    try {
      await writeFile(aliasPath, content, { encoding: 'utf8', flag: 'wx' });
      return { command, status: 'created', aliasPath, targetPath };
    } catch {
      return { command, status: 'unavailable', aliasPath, targetPath };
    }
  }
  try {
    const info = await lstat(aliasPath);
    if (!info.isSymbolicLink()) return { command, status: 'conflict', aliasPath, targetPath };
    const currentTarget = await readlink(aliasPath);
    const resolvedTarget = path.resolve(path.dirname(aliasPath), currentTarget);
    return {
      command,
      status: resolvedTarget === targetPath ? 'unchanged' : 'conflict',
      aliasPath,
      targetPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { command, status: 'unavailable', aliasPath, targetPath };
    }
  }
  try {
    await symlink(targetPath, aliasPath);
    return { command, status: 'created', aliasPath, targetPath };
  } catch {
    return { command, status: 'unavailable', aliasPath, targetPath };
  }
}

export async function provisionDesktopCommandAliases(
  options: DesktopCommandAliasOptions
): Promise<DesktopCommandAliasResult[]> {
  const platform = options.platform ?? process.platform;
  const suffix = platform === 'win32' ? '.cmd' : '';
  const targets = [
    {
      command: 'agentpanel' as const,
      targetPath: path.join(options.hermitHome, 'bin', `agentpanel${suffix}`),
    },
    { command: 'pi' as const, targetPath: path.join(options.hermitHome, 'bin', `pi${suffix}`) },
  ];
  const candidateDirs = options.candidateDirs ?? defaultCandidateDirs(platform);
  const directory = await (async () => {
    for (const candidate of candidateDirs) {
      if (await writableDirectory(candidate)) return candidate;
    }
    return null;
  })();
  if (!directory) {
    return targets.map(({ command, targetPath }) => ({
      command,
      targetPath,
      status: 'unavailable',
    }));
  }
  return Promise.all(
    targets.map(({ command, targetPath }) =>
      provisionAlias(command, targetPath, directory, platform)
    )
  );
}

import type { FastifyInstance, FastifyRequest } from 'fastify';

interface TerminalRouteDependencies {
  assertTrustedBrowserOrigin(request: FastifyRequest): void;
  getSessionId(sessionKey: string): string | undefined;
  resolveWorkDir(teamName: string): Promise<string>;
  resolveClaudeBinary(): Promise<string | null>;
  openTerminal?: (shellLine: string, windowsShellLine: string) => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appleScriptStringLiteral(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => `"${escapeAppleScriptString(line)}"`)
    .join(' & linefeed & ');
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void import('node:child_process')
      .then(({ execFile }) => {
        execFile(file, args, (error) => {
          if (error) reject(error);
          else resolve();
        });
      })
      .catch(reject);
  });
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void import('node:child_process')
      .then(({ spawn }) => {
        const child = spawn(file, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      })
      .catch(reject);
  });
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function openCommandInSystemTerminal(
  shellLine: string,
  windowsShellLine: string
): Promise<void> {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\ndo script ${appleScriptStringLiteral(shellLine)}\nactivate\nend tell`;
    await execFileAsync('osascript', ['-e', script]);
    return;
  }
  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', windowsShellLine]);
    return;
  }

  const candidates = [
    ...(process.env.TERMINAL
      ? [{ file: process.env.TERMINAL, args: ['-e', 'sh', '-lc', shellLine] }]
      : []),
    { file: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'gnome-terminal', args: ['--', 'sh', '-lc', shellLine] },
    { file: 'konsole', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'xfce4-terminal', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'alacritty', args: ['-e', 'sh', '-lc', shellLine] },
    { file: 'kitty', args: ['sh', '-lc', shellLine] },
    { file: 'wezterm', args: ['start', '--', 'sh', '-lc', shellLine] },
  ];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.file, candidate.args);
      return;
    } catch (error) {
      errors.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No system terminal launcher succeeded. ${errors.join('; ')}`);
}

export function registerTerminalRoutes(
  app: FastifyInstance,
  {
    assertTrustedBrowserOrigin,
    getSessionId,
    resolveWorkDir,
    resolveClaudeBinary,
    openTerminal = openCommandInSystemTerminal,
  }: TerminalRouteDependencies
): void {
  app.post<{ Body: { command: string; args?: string[]; cwd?: string } }>(
    '/api/terminal/open-external',
    async (request, reply) => {
      try {
        assertTrustedBrowserOrigin(request);
        const { command, args = [], cwd } = request.body ?? {};
        if (!command) return reply.code(400).send({ error: 'command is required' });
        const normalizedArgs = Array.isArray(args)
          ? args.filter((argument) => typeof argument === 'string')
          : [];
        const commandLine = [command, ...normalizedArgs].map(shellQuote).join(' ');
        const shellLine = cwd ? `cd ${shellQuote(cwd)} && ${commandLine}` : commandLine;
        const windowsCommand = [command, ...normalizedArgs].map(cmdQuote).join(' ');
        const windowsShellLine = cwd
          ? `cd /d ${cmdQuote(cwd)} && ${windowsCommand}`
          : windowsCommand;
        await openTerminal(shellLine, windowsShellLine);
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply
          .code(message.startsWith('Forbidden origin:') ? 403 : 500)
          .send({ error: message });
      }
    }
  );

  app.post<{
    Body: {
      teamName?: string;
      memberName?: string;
      resumeSessionId?: string;
      agentSessionId?: string;
      cwd?: string;
    };
  }>('/api/direct-cli/resume-in-terminal', async (request, reply) => {
    try {
      assertTrustedBrowserOrigin(request);
      const { teamName, memberName, resumeSessionId, agentSessionId, cwd } = request.body ?? {};
      let sessionId: string | undefined;
      let workDir = '';
      const directSessionId = resumeSessionId?.trim() || agentSessionId?.trim() || '';
      if (directSessionId) {
        sessionId = directSessionId;
        workDir = cwd?.trim() || '';
      } else if (teamName) {
        const member = memberName?.trim() || 'lead';
        const sessionKey = `${teamName}:member:${member}`;
        sessionId = getSessionId(sessionKey);
        workDir = cwd?.trim() || (await resolveWorkDir(teamName).catch(() => ''));
        if (!sessionId) {
          return reply.code(404).send({ error: `No Claude session found for ${sessionKey}` });
        }
      } else {
        return reply.code(400).send({ error: 'teamName or resumeSessionId is required' });
      }

      const binary = (await resolveClaudeBinary().catch(() => null)) || 'claude';
      const args = ['--resume', sessionId];
      const commandLine = [binary, ...args].map(shellQuote).join(' ');
      const shellLine = workDir ? `cd ${shellQuote(workDir)} && ${commandLine}` : commandLine;
      const windowsCommand = [binary, ...args].map(cmdQuote).join(' ');
      const windowsShellLine = workDir
        ? `cd /d ${cmdQuote(workDir)} && ${windowsCommand}`
        : windowsCommand;
      await openTerminal(shellLine, windowsShellLine);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply
        .code(message.startsWith('Forbidden origin:') ? 403 : 500)
        .send({ error: message });
    }
  });
}

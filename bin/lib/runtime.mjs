// runtime.mjs — minimal local Workbench process helpers.
// cc-connect lifecycle is owned by the Workbench external-channel routes, not
// by the terminal entry point.
import net from 'node:net';
import path from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { binDir, port, require } from './env.mjs';
import { brandCommand, brandLogPrefix } from '../branding.mjs';

function appendLog(filePath, chunk) {
  try {
    appendFileSync(filePath, chunk);
  } catch {
    // Logging must never prevent the Workbench from starting.
  }
}

function printLogTail(label, filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trimEnd().split(/\r?\n/u).slice(-80);
    console.error(`${brandLogPrefix()} ${label} log: ${filePath}`);
    if (lines.length > 0) console.error(lines.join('\n'));
  } catch {
    console.error(`${brandLogPrefix()} ${label} log: ${filePath}`);
  }
}

function resolveTsxLoader() {
  return pathToFileURL(require.resolve('tsx')).href;
}

function resolveAliasLoaderRegister() {
  const aliasLoaderUrl = pathToFileURL(path.join(binDir, 'alias-loader.mjs')).href;
  return `data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(aliasLoaderUrl)}, pathToFileURL("./"));`;
}

async function checkExistingOpenHermitServer() {
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1_000) });
    if (response.ok)
      return { running: true, version: (await response.text()).trim() || 'unknown', url };
  } catch {
    // Port may be unused or owned by another process.
  }
  return { running: false, version: '', url };
}

async function isTcpPortAvailable(portNumber) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(portNumber, process.env.HOST || '127.0.0.1');
  });
}

async function assertWebPortAvailable() {
  const existingServer = await checkExistingOpenHermitServer();
  if (existingServer.running) {
    console.log(`${brandLogPrefix()} Already running: ${existingServer.url}`);
    console.log(`${brandLogPrefix()} Version: ${existingServer.version}`);
    process.exit(0);
  }
  const available = await isTcpPortAvailable(Number.parseInt(port, 10));
  if (available) return;
  console.error(`${brandLogPrefix()} Port ${port} is already in use.`);
  console.error(
    `${brandLogPrefix()} Stop the existing process first, or use ${brandCommand('--port <port>')}.`
  );
  process.exit(1);
}

export {
  appendLog,
  assertWebPortAvailable,
  checkExistingOpenHermitServer,
  isTcpPortAvailable,
  printLogTail,
  resolveAliasLoaderRegister,
  resolveTsxLoader,
};

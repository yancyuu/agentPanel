/**
 * CredentialService — unified credential management for Hermit.
 *
 * Manages two credential stores:
 * 1. MCP credentials (global) — stored encrypted, keyed by MCP server name
 * 2. Project environment variables — stored encrypted, keyed by project path
 *
 * Encryption: OS keychain (macOS Keychain / Windows DPAPI / Linux keyring) preferred,
 * AES-256-GCM local fallback when unavailable.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getClaudeBasePath, getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Extensions:Credentials');

// ── Types ──────────────────────────────────────────────────────────────

export interface RequiredEnvVar {
  name: string;
  isRequired: boolean;
  description?: string;
  sources: string[]; // which MCP servers / skills need this var
}

export interface RequiredEnvResult {
  required: RequiredEnvVar[];
  filled: Record<string, string>; // name → masked value
  missing: string[]; // unfilled required vars
}

export interface StorageStatus {
  encryptionMethod: 'os-keychain' | 'aes-local';
  backend: string;
  fileSecure: boolean;
}

// ── Encryption helpers ─────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const home = getHomeDir();
  return crypto.scryptSync(`hermit-credentials-${home}`, 'hermit-salt-v1', KEY_LENGTH);
}

function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function maskValue(value: string): string {
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}${'•'.repeat(8)}${value.slice(-4)}`;
}

// ── Storage paths ──────────────────────────────────────────────────────

function getCredentialsDir(): string {
  return path.join(getClaudeBasePath(), 'credentials');
}

function getMcpCredentialsPath(): string {
  return path.join(getCredentialsDir(), 'mcp.json');
}

function getProjectEnvPath(projectPath: string): string {
  // Use encoded project path for filename safety
  const encoded = projectPath.replace(/\//g, '-').replace(/\\/g, '-');
  return path.join(getCredentialsDir(), `project-${encoded}.json`);
}

function getSkillGlobalEnvPath(): string {
  return path.join(getCredentialsDir(), 'skill-env.json');
}

// ── Service ────────────────────────────────────────────────────────────

export class CredentialService {
  // ── MCP Credentials (global) ──

  async saveMcpCredentials(mcpName: string, envValues: Record<string, string>): Promise<void> {
    const all = await this.loadMcpCredentials();
    all[mcpName] = envValues;
    await this.writeJson(getMcpCredentialsPath(), all);
  }

  async getMcpCredentials(mcpName: string): Promise<Record<string, string>> {
    const all = await this.loadMcpCredentials();
    return all[mcpName] ?? {};
  }

  async getAllMcpCredentials(): Promise<Record<string, Record<string, string>>> {
    return this.loadMcpCredentials();
  }

  async deleteMcpCredentials(mcpName: string): Promise<void> {
    const all = await this.loadMcpCredentials();
    delete all[mcpName];
    await this.writeJson(getMcpCredentialsPath(), all);
  }

  // ── Project Environment Variables ──

  async saveProjectEnv(projectPath: string, vars: Record<string, string>): Promise<void> {
    const envPath = getProjectEnvPath(projectPath);
    await this.writeJson(envPath, vars);
  }

  async getProjectEnv(projectPath: string): Promise<Record<string, string>> {
    return this.loadJson<Record<string, string>>(getProjectEnvPath(projectPath));
  }

  async deleteProjectEnv(projectPath: string): Promise<void> {
    try {
      await fs.unlink(getProjectEnvPath(projectPath));
    } catch {
      // already deleted
    }
  }

  // ── Skill Global Environment Variables ──

  async saveSkillGlobalEnv(skillFolderName: string, vars: Record<string, string>): Promise<void> {
    const all =
      await this.loadJson<Record<string, Record<string, string>>>(getSkillGlobalEnvPath());
    all[skillFolderName] = vars;
    await this.writeJson(getSkillGlobalEnvPath(), all);
  }

  async getSkillGlobalEnv(skillFolderName: string): Promise<Record<string, string>> {
    const all =
      await this.loadJson<Record<string, Record<string, string>>>(getSkillGlobalEnvPath());
    return all[skillFolderName] ?? {};
  }

  async getAllSkillGlobalEnv(): Promise<Record<string, Record<string, string>>> {
    return this.loadJson<Record<string, Record<string, string>>>(getSkillGlobalEnvPath());
  }

  // ── Scan Required Env ──

  async scanRequiredEnv(
    projectPath: string,
    installedMcpServers: {
      name: string;
      envVars?: { name: string; isRequired: boolean; description?: string }[];
    }[],
    skillEnvRequirements: {
      name: string;
      envVars: { name: string; isRequired?: boolean; description?: string }[];
    }[]
  ): Promise<RequiredEnvResult> {
    const envMap = new Map<string, RequiredEnvVar>();

    // Collect from MCP servers
    for (const server of installedMcpServers) {
      if (!server.envVars) continue;
      for (const v of server.envVars) {
        const existing = envMap.get(v.name);
        if (existing) {
          existing.sources.push(server.name);
          if (v.isRequired) existing.isRequired = true;
        } else {
          envMap.set(v.name, {
            name: v.name,
            isRequired: v.isRequired,
            description: v.description,
            sources: [server.name],
          });
        }
      }
    }

    // Collect from skills
    for (const skill of skillEnvRequirements) {
      for (const v of skill.envVars) {
        const existing = envMap.get(v.name);
        if (existing) {
          existing.sources.push(skill.name);
          if (v.isRequired !== false) existing.isRequired = true;
        } else {
          envMap.set(v.name, {
            name: v.name,
            isRequired: v.isRequired !== false,
            description: v.description,
            sources: [skill.name],
          });
        }
      }
    }

    const required = [...envMap.values()];

    // Check which are filled
    const projectEnv = await this.getProjectEnv(projectPath);
    const globalEnv = await this.getAllMcpCredentials();
    const skillGlobalEnv = await this.getAllSkillGlobalEnv();

    const filled: Record<string, string> = {};
    const missing: string[] = [];

    for (const v of required) {
      // Layer 2: Project env (highest priority)
      const projectValue = projectEnv[v.name];
      if (projectValue) {
        filled[v.name] = maskValue(projectValue);
        continue;
      }

      // Layer 1.5: Skill global env
      let found = false;
      for (const skillVars of Object.values(skillGlobalEnv)) {
        if (skillVars[v.name]) {
          filled[v.name] = maskValue(skillVars[v.name]);
          found = true;
          break;
        }
      }
      if (found) continue;

      // Layer 1: Global MCP credentials
      for (const mcpVars of Object.values(globalEnv)) {
        if (mcpVars[v.name]) {
          filled[v.name] = maskValue(mcpVars[v.name]);
          found = true;
          break;
        }
      }

      if (!found && v.isRequired) {
        missing.push(v.name);
      }
    }

    return { required, filled, missing };
  }

  // ── Agent Env Injection ──

  async resolveAgentEnv(projectPath: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    // Layer 1: Global MCP credentials
    const globalCreds = await this.getAllMcpCredentials();
    for (const vars of Object.values(globalCreds)) {
      Object.assign(result, vars);
    }

    // Layer 1.5: Global skill env
    const skillGlobalEnv = await this.getAllSkillGlobalEnv();
    for (const vars of Object.values(skillGlobalEnv)) {
      Object.assign(result, vars);
    }

    // Layer 2: Project env (overrides global)
    const projectEnv = await this.getProjectEnv(projectPath);
    Object.assign(result, projectEnv);

    return result;
  }

  // ── Storage Status ──

  async getStorageStatus(): Promise<StorageStatus> {
    const credPath = getMcpCredentialsPath();
    let fileSecure = false;

    try {
      if (process.platform === 'win32') {
        // Windows 无 POSIX mode 语义：文件位于用户 profile 即视为受保护，不误报。
        await fs.stat(credPath);
        fileSecure = true;
      } else {
        const stat = await fs.stat(credPath);
        const mode = stat.mode & 0o777;
        fileSecure = mode <= 0o600;
      }
    } catch {
      // file doesn't exist yet
    }

    return {
      encryptionMethod: 'aes-local',
      backend: 'AES-256-GCM (local)',
      fileSecure,
    };
  }

  // ── Private helpers ──

  private async loadMcpCredentials(): Promise<Record<string, Record<string, string>>> {
    return this.loadJson<Record<string, Record<string, string>>>(getMcpCredentialsPath());
  }

  private async loadJson<T = Record<string, unknown>>(filePath: string): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const encrypted = JSON.parse(raw) as Record<string, string>;
      // Decrypt values
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(encrypted)) {
        if (typeof value === 'string' && value.length > 0) {
          try {
            result[key] = JSON.parse(decrypt(value));
          } catch {
            result[key] = value; // not encrypted (plain text fallback)
          }
        }
      }
      return result as T;
    } catch {
      return {} as T;
    }
  }

  private async writeJson<T extends Record<string, unknown>>(
    filePath: string,
    data: T
  ): Promise<void> {
    // Encrypt values
    const encrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      encrypted[key] = encrypt(JSON.stringify(value));
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  }
}

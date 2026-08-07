/**
 * ProjectMappingStore — Persists the mapping between Hermit team members
 * and hermit-bridge project names.
 *
 * Storage: ~/.hermit/cc-connect-mappings.json
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { HermitBridgeAgentType, HermitBridgeProjectMapping } from '@shared/types/hermitBridge';

const logger = createLogger('ProjectMappingStore');

/**
 * Generate a deterministic hermit-bridge project name from team/member names.
 * Format: hermit-{teamName}-{memberName} (slug-ified)
 */
export function buildHermitBridgeProjectName(teamName: string, memberName: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  return `hermit-${slug(teamName)}-${slug(memberName)}`;
}

export class ProjectMappingStore {
  private mappings: HermitBridgeProjectMapping[] = [];
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'cc-connect-mappings.json');
    this.load();
  }

  // ===========================================================================
  // Read
  // ===========================================================================

  getProjectName(teamName: string, memberName: string): string | null {
    const entry = this.mappings.find((m) => m.teamName === teamName && m.memberName === memberName);
    return entry?.ccProjectName ?? null;
  }

  getTeamProjects(teamName: string): HermitBridgeProjectMapping[] {
    return this.mappings.filter((m) => m.teamName === teamName);
  }

  getAllMappings(): HermitBridgeProjectMapping[] {
    return [...this.mappings];
  }

  findByProjectName(ccProjectName: string): HermitBridgeProjectMapping | null {
    return this.mappings.find((m) => m.ccProjectName === ccProjectName) ?? null;
  }

  // ===========================================================================
  // Write
  // ===========================================================================

  setMapping(
    teamName: string,
    memberName: string,
    agentType: HermitBridgeAgentType,
    workDir: string,
    ccProjectName?: string
  ): HermitBridgeProjectMapping {
    const now = new Date().toISOString();
    const existing = this.mappings.find(
      (m) => m.teamName === teamName && m.memberName === memberName
    );

    if (existing) {
      existing.agentType = agentType;
      existing.workDir = workDir;
      existing.updatedAt = now;
      if (ccProjectName) existing.ccProjectName = ccProjectName;
      this.save();
      return existing;
    }

    const mapping: HermitBridgeProjectMapping = {
      teamName,
      memberName,
      ccProjectName: ccProjectName ?? buildHermitBridgeProjectName(teamName, memberName),
      agentType,
      workDir,
      createdAt: now,
      updatedAt: now,
    };
    this.mappings.push(mapping);
    this.save();
    return mapping;
  }

  updateSessionKey(teamName: string, memberName: string, sessionKey: string): void {
    const entry = this.mappings.find((m) => m.teamName === teamName && m.memberName === memberName);
    if (entry) {
      entry.sessionKey = sessionKey;
      entry.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  removeMapping(teamName: string, memberName: string): void {
    this.mappings = this.mappings.filter(
      (m) => !(m.teamName === teamName && m.memberName === memberName)
    );
    this.save();
  }

  removeTeamMappings(teamName: string): void {
    this.mappings = this.mappings.filter((m) => m.teamName !== teamName);
    this.save();
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.mappings = JSON.parse(data) as HermitBridgeProjectMapping[];
      }
    } catch (error) {
      logger.warn(`Failed to load mappings from ${this.filePath}: ${getErrorMessage(error)}`);
      this.mappings = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.mappings, null, 2), 'utf-8');
    } catch (error) {
      logger.warn(`Failed to save mappings to ${this.filePath}: ${getErrorMessage(error)}`);
    }
  }
}

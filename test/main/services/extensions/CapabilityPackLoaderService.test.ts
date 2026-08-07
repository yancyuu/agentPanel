import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CapabilityPackLoaderService,
  buildTeamCapabilityTelemetrySnapshots,
} from '@main/services/extensions/capability-packs/CapabilityPackLoaderService';
import { ensureGlobalWorkflows, listHermitWorkflows } from '@main/services/system-manager/BuiltinWorkflowSeeder';

import type { HermitBridgeCronJob } from '@shared/types/hermitBridge';
import type { SkillCatalogItem } from '@shared/types/extensions';

let tmpDir: string;
let rootDir: string;
let originalHermitHome: string | undefined;

function buildSkill(overrides: Partial<SkillCatalogItem> = {}): SkillCatalogItem {
  const skillDir = path.join(tmpDir, 'skills', overrides.folderName ?? 'local-review');
  return {
    id: skillDir,
    sourceType: 'filesystem',
    name: 'local-review',
    description: 'Review local changes',
    folderName: 'local-review',
    scope: 'project',
    rootKind: 'claude',
    projectRoot: tmpDir,
    discoveryRoot: path.dirname(skillDir),
    skillDir,
    skillFile: path.join(skillDir, 'SKILL.md'),
    metadata: {},
    invocationMode: 'auto',
    flags: { hasScripts: false, hasReferences: false, hasAssets: false },
    isValid: true,
    issues: [],
    modifiedAt: 1,
    ...overrides,
  };
}

function buildCron(overrides: Partial<HermitBridgeCronJob> = {}): HermitBridgeCronJob {
  return {
    id: 'cron-local-review',
    project: 'hermit',
    session_key: 'hermit:review',
    cron_expr: '17 9 * * 1-5',
    prompt: '/hermit:summary',
    description: 'Weekday local review',
    enabled: true,
    created_at: '2026-06-16T00:00:00.000Z',
    ...overrides,
  };
}

function createService(
  options: { skills?: SkillCatalogItem[]; cron?: HermitBridgeCronJob[]; skillsError?: boolean } = {}
) {
  const skillsCatalog = {
    list: async () => {
      if (options.skillsError) throw new Error('skills unavailable');
      return options.skills ?? [];
    },
  };
  const mcpReader = {
    readConfigured: async () => [
      {
        name: 'context7',
        scope: 'user' as const,
        transport: 'stdio',
        config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      },
    ],
  };
  return new CapabilityPackLoaderService(
    rootDir,
    skillsCatalog as any,
    mcpReader as any,
    { projectPath: tmpDir, listCronJobs: async () => options.cron ?? [] }
  );
}

function writePack(packDir: string, id = 'yancy-loop-ops'): void {
  fs.mkdirSync(path.join(packDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(packDir, 'skills/ops-diagnosis'), { recursive: true });
  fs.mkdirSync(path.join(packDir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'commands/doctor.md'), '# Doctor\n', 'utf8');
  fs.writeFileSync(path.join(packDir, 'skills/ops-diagnosis/SKILL.md'), '# Skill\n', 'utf8');
  fs.writeFileSync(path.join(packDir, 'workflows/daily-hygiene.md'), '# Workflow\n', 'utf8');
  fs.writeFileSync(
    path.join(packDir, 'pack.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id,
        name: 'Yancy Loop Ops',
        namespace: 'yancy',
        version: '1.0.0',
        author: 'Yancy',
        description: 'Loop Engineering ops pack',
        capabilities: {
          commands: [
            {
              id: 'doctor',
              alias: 'doctor',
              title: 'Loop Doctor',
              description: 'Diagnose Hermit Loop runtime',
              scope: ['admin-loop'],
              surfaces: ['slash'],
              safety: 'read-only',
              prompt: 'commands/doctor.md',
              usesSkills: ['ops-diagnosis'],
              workflow: null,
              order: 10,
            },
          ],
          skills: [
            {
              id: 'ops-diagnosis',
              name: 'Ops Diagnosis',
              description: 'Runtime diagnostics',
              path: 'skills/ops-diagnosis',
            },
          ],
          workflows: [
            {
              id: 'daily-hygiene',
              name: 'Daily Folder Hygiene',
              description: 'Daily folder inspection',
              path: 'workflows/daily-hygiene.md',
            },
          ],
        },
      },
      null,
      2
    ),
    'utf8'
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-capability-packs-'));
  rootDir = path.join(tmpDir, 'capability-packs');
  originalHermitHome = process.env.HERMIT_HOME;
  process.env.HERMIT_HOME = tmpDir;
  await ensureGlobalWorkflows();
});

afterEach(() => {
  process.env.HERMIT_HOME = originalHermitHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CapabilityPackLoaderService', () => {
  it('lists the built-in Hermit team ops pack by default', async () => {
    const service = createService();
    const workflows = await listHermitWorkflows();

    const result = await service.list();

    expect(result.packs[0]).toMatchObject({
      source: 'builtin',
      enabled: true,
      manifest: {
        id: 'hermit-team-ops',
        name: 'AgentPanel Team Ops',
        namespace: 'hermit',
      },
    });
    expect(result.packs[0].manifest.capabilities.commands).toEqual(
      workflows.map((workflow) =>
        expect.objectContaining({
          id: workflow.id,
          alias: workflow.id,
          scope: ['admin-loop', 'team-loop'],
          execution: { type: 'loop-session', reuse: true },
        })
      )
    );
    expect(result.packs[0].manifest.capabilities.workflows).toEqual(
      workflows.map((workflow) =>
        expect.objectContaining({
          id: workflow.id,
          path: `workflows/${workflow.filename}`,
        })
      )
    );
  });

  it('loads local pack manifests from the capability-packs root', async () => {
    const packDir = path.join(rootDir, 'yancy-loop-ops');
    writePack(packDir);
    const service = createService();

    const result = await service.list();

    expect(result.rootDir).toBe(rootDir);
    expect(result.warnings).toEqual([]);
    expect(result.packs[0]).toMatchObject({
      source: 'builtin',
      manifest: { id: 'hermit-team-ops', namespace: 'hermit' },
    });
    expect(result.packs[1]).toMatchObject({
      source: 'local',
      manifest: { namespace: 'local', tags: ['local'] },
    });
    const userPack = result.packs.find((pack) => pack.manifest.id === 'yancy-loop-ops');
    expect(userPack).toMatchObject({
      packDir,
      source: 'user',
      enabled: true,
      manifest: {
        id: 'yancy-loop-ops',
        namespace: 'yancy',
        capabilities: {
          commands: [{ id: 'doctor', alias: 'doctor', safety: 'read-only' }],
        },
      },
    });
  });

  it('surfaces local capability packs grouped by team under the local tag', async () => {
    const skill = buildSkill();
    fs.mkdirSync(skill.skillDir, { recursive: true });
    fs.writeFileSync(skill.skillFile, '# Local review\n', 'utf8');
    const service = createService({ skills: [skill], cron: [buildCron()] });

    const result = await service.list();

    const localPacks = result.packs.filter((pack) => pack.source === 'local');
    const personalPack = localPacks.find((pack) => pack.manifest.teamName === path.basename(tmpDir));
    const teamPack = localPacks.find((pack) => pack.manifest.teamName === 'hermit');

    expect(personalPack).toMatchObject({
      source: 'local',
      enabled: true,
      manifest: {
        namespace: 'local',
        tags: ['local'],
        capabilities: {
          skills: [{ id: 'local-review', path: skill.skillDir }],
          mcpServers: [{ id: 'context7', name: 'context7', scope: 'user' }],
        },
      },
    });
    expect(personalPack?.manifest.capabilities.workflows?.length).toBeGreaterThan(0);
    expect(teamPack).toMatchObject({
      source: 'local',
      enabled: true,
      manifest: {
        namespace: 'local',
        tags: ['local'],
        teamName: 'hermit',
        capabilities: {
          cron: [
            {
              id: 'cron-local-review',
              cronExpression: '17 9 * * 1-5',
              prompt: '/hermit:summary',
            },
          ],
        },
      },
    });
  });

  it('attaches local scan warnings to every generated local pack', async () => {
    const service = createService({ skillsError: true, cron: [buildCron({ project: 'aaa-team' })] });

    const result = await service.list();

    const localPacks = result.packs.filter((pack) => pack.source === 'local');
    expect(localPacks.length).toBeGreaterThan(1);
    expect(localPacks.every((pack) => pack.warnings.includes('Unable to scan local skills.'))).toBe(true);
  });

  it('exports the fallback local pack for the legacy local-capabilities id', async () => {
    const skill = buildSkill();
    fs.mkdirSync(skill.skillDir, { recursive: true });
    fs.writeFileSync(skill.skillFile, '# Local review\n', 'utf8');
    const service = createService({ skills: [skill], cron: [buildCron({ project: 'aaa-team' })] });
    const destinationDir = path.join(tmpDir, 'legacy-export');

    const result = await service.exportPack({
      packId: 'local-capabilities',
      destinationDir,
      runtime: 'codex',
    });

    expect(result.pack?.manifest.teamName).toBe(path.basename(tmpDir));
    expect(result.pack?.manifest.capabilities.skills).toEqual([
      expect.objectContaining({ id: 'local-review', path: 'skills/local-review' }),
    ]);
    expect(result.pack?.manifest.capabilities.cron).toEqual([]);
  });

  it('exports one team-scoped local capability pack as a runtime-specific configuration package', async () => {
    const skill = buildSkill();
    fs.mkdirSync(skill.skillDir, { recursive: true });
    fs.writeFileSync(skill.skillFile, '# Local review\n', 'utf8');
    const service = createService({ skills: [skill], cron: [buildCron()] });
    const destinationDir = path.join(tmpDir, 'exports');

    const listResult = await service.list();
    const packId = listResult.packs.find((pack) => pack.manifest.teamName === path.basename(tmpDir))
      ?.manifest.id;
    expect(packId).toBeTruthy();

    const result = await service.exportPack({
      packId: packId!,
      destinationDir,
      runtime: 'codex',
    });

    const exportedDir = path.join(destinationDir, packId!);
    expect(result.pack?.source).toBe('local');
    const manifest = JSON.parse(fs.readFileSync(path.join(exportedDir, 'pack.json'), 'utf8'));
    expect(manifest.capabilities.skills).toEqual([
      expect.objectContaining({ id: 'local-review', path: 'skills/local-review' }),
    ]);
    expect(fs.existsSync(path.join(exportedDir, 'skills/local-review/SKILL.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(exportedDir, 'cron/schedules.json'), 'utf8'))).toEqual([]);
    expect(manifest.capabilities.mcpServers[0]).not.toHaveProperty('config');
    const exportedMcpServers = JSON.parse(
      fs.readFileSync(path.join(exportedDir, 'mcp/servers.json'), 'utf8')
    );
    expect(exportedMcpServers).toEqual([expect.objectContaining({ id: 'context7', scope: 'user' })]);
    expect(exportedMcpServers[0]).not.toHaveProperty('config');
    expect(JSON.parse(fs.readFileSync(path.join(exportedDir, 'runtime/codex.json'), 'utf8'))).toMatchObject({
      runtime: 'codex',
      packId,
      counts: { skills: 1, cron: 0, mcpServers: 1 },
    });
  });

  it('builds sanitized capability telemetry snapshots with stable fingerprints', async () => {
    const skill = buildSkill({ description: 'Review local changes safely' });
    fs.mkdirSync(skill.skillDir, { recursive: true });
    fs.writeFileSync(skill.skillFile, '# Local review secret body\n', 'utf8');
    const service = createService({
      skills: [skill],
      cron: [buildCron({ prompt: 'SECRET CRON PROMPT', description: 'Weekday report' })],
    });

    const listResult = await service.list();
    const snapshots = buildTeamCapabilityTelemetrySnapshots(listResult.packs, {
      reportedAt: '2026-06-18T00:00:00.000Z',
    });
    const laterSnapshots = buildTeamCapabilityTelemetrySnapshots(listResult.packs, {
      reportedAt: '2026-06-18T00:10:00.000Z',
    });
    const personalSnapshot = snapshots.find((snapshot) => snapshot.teamName === path.basename(tmpDir));
    const laterPersonalSnapshot = laterSnapshots.find(
      (snapshot) => snapshot.teamName === path.basename(tmpDir)
    );
    const cronSnapshot = snapshots.find((snapshot) => snapshot.teamName === 'hermit');

    expect(personalSnapshot).toMatchObject({
      teamSlug: path.basename(tmpDir).toLowerCase(),
      counts: expect.objectContaining({ skills: 1, workflows: expect.any(Number), mcpServers: 1 }),
    });
    expect(personalSnapshot?.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          id: 'local-review',
          name: 'local-review',
          description: 'Review local changes safely',
        }),
        expect.objectContaining({ kind: 'mcp', id: 'context7', name: 'context7', transport: 'stdio' }),
      ])
    );
    expect(cronSnapshot?.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'cron',
          id: 'cron-local-review',
          name: 'Weekday report',
          description: 'Weekday report',
          scope: '17 9 * * 1-5',
        }),
      ])
    );
    expect(laterPersonalSnapshot?.fingerprint).toBe(personalSnapshot?.fingerprint);

    const serialized = JSON.stringify(snapshots);
    expect(serialized).not.toContain(skill.skillDir);
    expect(serialized).not.toContain(skill.skillFile);
    expect(serialized).not.toContain('SECRET CRON PROMPT');
    expect(serialized).not.toContain('@upstash/context7-mcp');
    expect(serialized).not.toContain('"config"');
  });

  it('imports a source folder containing pack.json', async () => {
    const sourceDir = path.join(tmpDir, 'source-pack');
    writePack(sourceDir, 'source-pack');
    const service = createService();

    const result = await service.importPack({ sourceDir });

    expect(result.pack?.manifest.id).toBe('source-pack');
    expect(fs.existsSync(path.join(rootDir, 'source-pack/commands/doctor.md'))).toBe(true);
  });

  it('returns warnings for missing referenced files without rejecting the pack', async () => {
    const packDir = path.join(rootDir, 'missing-ref');
    writePack(packDir, 'missing-ref');
    fs.rmSync(path.join(packDir, 'commands/doctor.md'));
    const service = createService();

    const result = await service.list();

    const pack = result.packs.find((entry) => entry.manifest.id === 'missing-ref');
    expect(pack?.warnings).toContain('Missing referenced file or folder: commands/doctor.md');
  });

  it('reads a command prompt by canonical id', async () => {
    const packDir = path.join(rootDir, 'yancy-loop-ops');
    writePack(packDir);
    const service = createService();

    const result = await service.getCommandPrompt({
      canonicalId: 'yancy-loop-ops.doctor',
      scope: 'admin-loop',
    });

    expect(result.command.canonicalId).toBe('yancy-loop-ops.doctor');
    expect(result.command.command.execution).toEqual({ type: 'loop-session', reuse: true });
    expect(result.prompt).toBe('# Doctor\n');
  });

  it('skips duplicate manifest ids', async () => {
    writePack(path.join(rootDir, 'first'), 'duplicate-pack');
    writePack(path.join(rootDir, 'second'), 'duplicate-pack');
    const service = createService();

    const result = await service.list();

    expect(result.packs.filter((pack) => pack.manifest.id === 'duplicate-pack')).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes('Duplicate capability pack id duplicate-pack'))).toBe(true);
  });

  it('rejects unsupported enum values in commands', async () => {
    const packDir = path.join(rootDir, 'bad-enum');
    writePack(packDir, 'bad-enum');
    const manifestPath = path.join(packDir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.capabilities.commands[0].safety = 'dangerous';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const service = createService();

    const result = await service.list();

    expect(result.packs.some((pack) => pack.manifest.id === 'bad-enum')).toBe(false);
    expect(result.warnings[0]).toContain('unsupported safety');
  });

  it('rejects namespaces containing slash separators', async () => {
    const packDir = path.join(rootDir, 'bad-namespace');
    writePack(packDir, 'bad-namespace');
    const manifestPath = path.join(packDir, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.namespace = 'bad:namespace';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const service = createService();

    const result = await service.list();

    expect(result.packs.some((pack) => pack.manifest.id === 'bad-namespace')).toBe(false);
    expect(result.warnings[0]).toContain('Capability pack namespace');
  });

  it('rejects unsupported schema versions', async () => {
    const packDir = path.join(rootDir, 'bad-schema');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({ schemaVersion: 2, id: 'bad', name: 'Bad', namespace: 'bad', version: '1.0.0' }),
      'utf8'
    );
    const service = createService();

    const result = await service.list();

    expect(result.packs.some((pack) => pack.manifest.id === 'bad')).toBe(false);
    expect(result.warnings[0]).toContain('Unsupported capability pack schemaVersion');
  });
});

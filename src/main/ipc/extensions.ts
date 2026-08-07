/**
 * IPC handlers for the Extension Store.
 *
 * Bridges renderer requests to the extension services (catalog, install,
 * state, skills, credentials) and returns results via IPC.
 */

import {
  CapabilityPackLoaderService,
  type LocalCapabilityPackSource,
} from '@main/services/extensions/capability-packs/CapabilityPackLoaderService';
import { PluginCatalogService } from '@main/services/extensions/catalog/PluginCatalogService';
import { CredentialService } from '@main/services/extensions/credentials/CredentialService';
import { ExtensionFacadeService } from '@main/services/extensions/ExtensionFacadeService';
import { McpLibraryService } from '@main/services/extensions/library/McpLibraryService';
import { getAdapter } from '@main/services/extensions/runtime/adapterRegistry';
import { SkillsCatalogService } from '@main/services/extensions/skills/SkillsCatalogService';
import { SkillsMutationService } from '@main/services/extensions/skills/SkillsMutationService';
import { SkillsWatcherService } from '@main/services/extensions/skills/SkillsWatcherService';
import { PluginInstallationStateService } from '@main/services/extensions/state/PluginInstallationStateService';
import { createLogger } from '@shared/utils/logger';

import type {
  CapabilityCommandPromptRequest,
  CapabilityPackExportRequest,
  CapabilityPackImportRequest,
  McpCustomInstallRequest,
  McpLibraryImportRequest,
  McpLibraryUpsertRequest,
  OperationResult,
  PluginInstallRequest,
  SkillDeleteRequest,
  SkillImportRequest,
  SkillUpsertRequest,
  SkillWatcherEvent,
} from '@shared/types/extensions';
import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

const logger = createLogger('Extensions:IPC');

// ── Result wrapper ──

interface IpcResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function wrapHandler<T>(handler: () => Promise<T>): Promise<IpcResult<T>> {
  return handler()
    .then((data) => ({ success: true as const, data }))
    .catch((err) => ({
      success: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
}

// ── Service instances (singleton) ──

let facade: ExtensionFacadeService | null = null;
let mcpLibrary: McpLibraryService | null = null;
let capabilityPacks: CapabilityPackLoaderService | null = null;
let skillsCatalog: SkillsCatalogService | null = null;
let skillsMutation: SkillsMutationService | null = null;
let skillsWatcher: SkillsWatcherService | null = null;
let credentials: CredentialService | null = null;

function getFacade(): ExtensionFacadeService {
  if (!facade) {
    const pluginCatalog = new PluginCatalogService();
    const pluginState = new PluginInstallationStateService();
    facade = new ExtensionFacadeService(pluginCatalog, pluginState);
  }
  return facade;
}

function getMcpLibrary(): McpLibraryService {
  if (!mcpLibrary) mcpLibrary = new McpLibraryService();
  return mcpLibrary;
}

export function getCapabilityPacks(): CapabilityPackLoaderService {
  if (!capabilityPacks) capabilityPacks = new CapabilityPackLoaderService();
  return capabilityPacks;
}

export function setCapabilityPackLocalSource(source: LocalCapabilityPackSource): void {
  getCapabilityPacks().setLocalSource(source);
}

function getSkillsCatalog(): SkillsCatalogService {
  if (!skillsCatalog) skillsCatalog = new SkillsCatalogService();
  return skillsCatalog;
}

function getSkillsMutation(): SkillsMutationService {
  if (!skillsMutation) skillsMutation = new SkillsMutationService();
  return skillsMutation;
}

function getSkillsWatcher(): SkillsWatcherService {
  if (!skillsWatcher) skillsWatcher = new SkillsWatcherService();
  return skillsWatcher;
}

/**
 * Wire the skills file-watcher to a transport-specific event emitter.
 * Called once at startup by each transport (Electron IPC → webContents.send,
 * standalone server → SSE broadcast).
 */
export function setSkillsWatcherEmitter(emit: (event: SkillWatcherEvent) => void): void {
  getSkillsWatcher().setEmitter(emit);
}

function getCredentials(): CredentialService {
  if (!credentials) credentials = new CredentialService();
  return credentials;
}

// ── IPC Channel Names ──

const channels = {
  PLUGIN_GET_ALL: 'extensions:plugin:getAll',
  PLUGIN_GET_README: 'extensions:plugin:getReadme',
  PLUGIN_INSTALL: 'extensions:plugin:install',
  PLUGIN_UNINSTALL: 'extensions:plugin:uninstall',
  MCP_SEARCH: 'extensions:mcp:search',
  MCP_BROWSE: 'extensions:mcp:browse',
  MCP_GET_BY_ID: 'extensions:mcp:getById',
  MCP_GET_INSTALLED: 'extensions:mcp:getInstalled',
  MCP_INSTALL: 'extensions:mcp:install',
  MCP_INSTALL_CUSTOM: 'extensions:mcp:installCustom',
  MCP_UNINSTALL: 'extensions:mcp:uninstall',
  CAPABILITY_PACKS_LIST: 'extensions:capabilityPacks:list',
  CAPABILITY_PACKS_IMPORT: 'extensions:capabilityPacks:import',
  CAPABILITY_PACKS_EXPORT: 'extensions:capabilityPacks:export',
  CAPABILITY_PACKS_COMMAND_PROMPT: 'extensions:capabilityPacks:commandPrompt',
  SKILLS_LIST: 'extensions:skills:list',
  SKILLS_GET_DETAIL: 'extensions:skills:getDetail',
  SKILLS_UPSERT: 'extensions:skills:upsert',
  SKILLS_DELETE: 'extensions:skills:delete',
  CREDENTIALS_GET_MCP: 'extensions:credentials:getMcp',
  CREDENTIALS_SAVE_MCP: 'extensions:credentials:saveMcp',
  CREDENTIALS_GET_PROJECT_ENV: 'extensions:credentials:getProjectEnv',
  CREDENTIALS_SAVE_PROJECT_ENV: 'extensions:credentials:saveProjectEnv',
  CREDENTIALS_SCAN_REQUIRED: 'extensions:credentials:scanRequired',
  CREDENTIALS_RESOLVE_AGENT_ENV: 'extensions:credentials:resolveAgentEnv',
  CREDENTIALS_STATUS: 'extensions:credentials:status',
} as const;

export { channels as extensionChannels };

// ── Handler Registration ──

// For Hermit's web-based architecture, handlers are exposed as an API object
// rather than Electron ipcMain.handle. The server.ts or API layer calls these.

export const extensionHandlers = {
  // ── Plugins ──

  pluginGetAll: () => wrapHandler(() => getFacade().getEnrichedPlugins()),

  pluginGetReadme: (pluginId: string) => wrapHandler(() => getFacade().getPluginReadme(pluginId)),

  pluginInstall: (request: PluginInstallRequest) =>
    wrapHandler(async () => {
      // Plugins are claudecode-only — no other harness supports them
      const harnessType = 'claudecode' as HermitBridgeAgentType;
      const adapter = getAdapter(harnessType);
      if (!adapter) return { state: 'error' as const, error: `No adapter for ${harnessType}` };

      // Resolve qualifiedName from catalog
      const resolved = await getFacade().getPluginReadme(request.pluginId);
      // For now, use pluginId as qualifiedName (catalog resolution TBD)
      const result = await adapter.installPlugin(request.pluginId, {
        scope: request.scope ?? 'user',
        projectPath: request.projectPath,
      });

      if (result.state === 'success') {
        getFacade().invalidateInstalledCache();
      }
      return result;
    }),

  pluginUninstall: (
    pluginId: string,
    scope?: string,
    projectPath?: string,
    harnessType?: HermitBridgeAgentType
  ) =>
    wrapHandler(async () => {
      const ht = harnessType ?? 'claudecode';
      const adapter = getAdapter(ht);
      if (!adapter) return { state: 'error' as const, error: `No adapter for ${ht}` };

      const result = await adapter.uninstallPlugin(pluginId, {
        scope: (scope as InstallOpts['scope']) ?? 'user',
        projectPath,
      });

      if (result.state === 'success') {
        getFacade().invalidateInstalledCache();
      }
      return result;
    }),

  // ── MCP ──

  mcpGetInstalled: (projectPath?: string) =>
    wrapHandler(async () => {
      const { createExtensionsRuntimeAdapter } =
        await import('@main/services/extensions/runtime/ExtensionsRuntimeAdapter');
      const adapter = createExtensionsRuntimeAdapter();
      return adapter.getInstalledMcp(projectPath);
    }),

  mcpInstallCustom: (request: McpCustomInstallRequest) =>
    wrapHandler(async () => {
      const harnessType = (request.harnessType ?? 'claudecode') as HermitBridgeAgentType;
      const adapter = getAdapter(harnessType);
      if (!adapter?.supportsMcp) {
        return { state: 'error' as const, error: `MCP not supported by ${harnessType}` };
      }

      const result = await adapter.installMcp(
        request.serverName,
        request.installSpec,
        request.envValues,
        request.headers,
        { scope: request.scope ?? 'user', projectPath: request.projectPath }
      );

      if (result.state === 'success') {
        getFacade().invalidateInstalledCache();
      }
      return result;
    }),

  mcpUninstall: (
    name: string,
    scope?: string,
    projectPath?: string,
    harnessType?: HermitBridgeAgentType
  ) =>
    wrapHandler(async () => {
      const ht = harnessType ?? 'claudecode';
      const adapter = getAdapter(ht);
      if (!adapter) return { state: 'error' as const, error: `No adapter for ${ht}` };

      const result = await adapter.uninstallMcp(name, {
        scope: (scope as InstallOpts['scope']) ?? 'user',
        projectPath,
      });

      if (result.state === 'success') {
        getFacade().invalidateInstalledCache();
      }
      return result;
    }),

  // ── MCP Library (cc-switch style global library) ──

  mcpLibraryList: () => wrapHandler(async () => getMcpLibrary().list()),

  mcpLibraryUpsert: (request: McpLibraryUpsertRequest) =>
    wrapHandler(async () => getMcpLibrary().upsert(request)),

  mcpLibraryDelete: (id: string) =>
    wrapHandler(async () => {
      getMcpLibrary().remove(id);
      return { ok: true };
    }),

  mcpLibraryImport: (request: McpLibraryImportRequest) =>
    wrapHandler(() => getMcpLibrary().importFromLive(request)),

  // ── Capability Packs ──

  capabilityPacksList: () => wrapHandler(() => getCapabilityPacks().list()),

  capabilityPacksImport: (request: CapabilityPackImportRequest) =>
    wrapHandler(() => getCapabilityPacks().importPack(request)),

  capabilityPacksExport: (request: CapabilityPackExportRequest) =>
    wrapHandler(() => getCapabilityPacks().exportPack(request)),

  capabilityPacksCommandPrompt: (request: CapabilityCommandPromptRequest) =>
    wrapHandler(() => getCapabilityPacks().getCommandPrompt(request)),

  // ── Skills ──

  skillsList: (projectPath?: string) => wrapHandler(() => getSkillsCatalog().list(projectPath)),

  skillsGetDetail: (skillId: string, projectPath?: string) =>
    wrapHandler(() => getSkillsCatalog().getDetail(skillId, projectPath)),

  skillsUpsert: (request: SkillUpsertRequest) =>
    wrapHandler(async () => {
      const mutation = getSkillsMutation();
      await mutation.applyUpsert(request);
      return { ok: true };
    }),

  skillsDelete: (request: SkillDeleteRequest) =>
    wrapHandler(async () => {
      const mutation = getSkillsMutation();
      await mutation.deleteSkill(request);
      return { ok: true };
    }),

  skillsPreviewUpsert: (request: SkillUpsertRequest) =>
    wrapHandler(() => getSkillsMutation().previewUpsert(request)),

  skillsApplyUpsert: (request: SkillUpsertRequest) =>
    wrapHandler(() => getSkillsMutation().applyUpsert(request)),

  skillsPreviewImport: (request: SkillImportRequest) =>
    wrapHandler(() => getSkillsMutation().previewImport(request)),

  skillsApplyImport: (request: SkillImportRequest) =>
    wrapHandler(() => getSkillsMutation().applyImport(request)),

  skillsStartWatching: (projectPath?: string) =>
    wrapHandler(() => getSkillsWatcher().start(projectPath)),

  skillsStopWatching: (watchId: string) =>
    wrapHandler(async () => {
      await getSkillsWatcher().stop(watchId);
      return { ok: true };
    }),

  // ── Credentials ──

  credentialsGetMcp: (mcpName: string) =>
    wrapHandler(() => getCredentials().getMcpCredentials(mcpName)),

  credentialsSaveMcp: (mcpName: string, envValues: Record<string, string>) =>
    wrapHandler(() => getCredentials().saveMcpCredentials(mcpName, envValues)),

  credentialsGetProjectEnv: (projectPath: string) =>
    wrapHandler(() => getCredentials().getProjectEnv(projectPath)),

  credentialsSaveProjectEnv: (projectPath: string, vars: Record<string, string>) =>
    wrapHandler(() => getCredentials().saveProjectEnv(projectPath, vars)),

  credentialsScanRequired: (
    projectPath: string,
    mcpServers: {
      name: string;
      envVars?: { name: string; isRequired: boolean; description?: string }[];
    }[],
    skillReqs: {
      name: string;
      envVars: { name: string; isRequired?: boolean; description?: string }[];
    }[]
  ) => wrapHandler(() => getCredentials().scanRequiredEnv(projectPath, mcpServers, skillReqs)),

  credentialsResolveAgentEnv: (projectPath: string) =>
    wrapHandler(() => getCredentials().resolveAgentEnv(projectPath)),

  credentialsGetSkillGlobalEnv: (skillFolderName: string) =>
    wrapHandler(() => getCredentials().getSkillGlobalEnv(skillFolderName)),

  credentialsSaveSkillGlobalEnv: (skillFolderName: string, vars: Record<string, string>) =>
    wrapHandler(() => getCredentials().saveSkillGlobalEnv(skillFolderName, vars)),

  credentialsStatus: () => wrapHandler(() => getCredentials().getStorageStatus()),
};

// Re-export for type usage
type InstallOpts = import('@main/services/extensions/runtime/HarnessInstallAdapter').InstallOpts;

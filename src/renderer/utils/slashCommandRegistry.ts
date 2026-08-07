import { isSupportedSlashCommandName, KNOWN_SLASH_COMMANDS } from '@shared/utils/slashCommands';

import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  CapabilityCommand,
  CapabilityScope,
  CapabilityWorkflow,
  LoadedCapabilityPack,
  RegisteredSlashCommand,
  SlashCommandResolveResult,
  SlashCommandSource,
} from '@shared/types/extensions';

export const RESERVED_SLASH_COMMANDS = new Set([
  ...KNOWN_SLASH_COMMANDS.map((command) => command.name.toLowerCase()),
  'help',
  'settings',
  'permissions',
  'login',
  'logout',
  'mcp',
  'agents',
  'hooks',
  'memory',
  // Reserved runtime names that should not be exposed as short capability-pack aliases.
  // They are intentionally not part of KNOWN_SLASH_COMMANDS so regular command boards
  // can omit them while still forcing pack commands to use namespaced forms.
  'loop',
  'system',
]);

interface SlashRegistryInput {
  packs?: readonly LoadedCapabilityPack[];
  scope?: CapabilityScope;
}

function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^\//, '').toLowerCase();
}

function normalizeNamespace(namespace: string): string {
  return namespace.trim().replace(/^\//, '').toLowerCase();
}

function isRegistryToken(value: string): boolean {
  return isSupportedSlashCommandName(value) && !value.includes(':');
}

function commandAppliesToScope(command: CapabilityCommand, scope?: CapabilityScope): boolean {
  if (!scope) return true;
  return command.scope.includes(scope);
}

function commandSupportsSlash(command: CapabilityCommand): boolean {
  return command.surfaces.includes('slash');
}

function workflowMatchesCommand(workflow: CapabilityWorkflow, command: CapabilityCommand): boolean {
  const commandWorkflow = command.workflow?.trim();
  if (!commandWorkflow) return false;
  const workflowPath = workflow.path.trim();
  const workflowFile = workflowPath.split(/[\\/]/u).pop();
  return (
    workflow.id === commandWorkflow ||
    workflowPath === commandWorkflow ||
    workflowFile === commandWorkflow ||
    workflowPath.endsWith(`/${commandWorkflow}`)
  );
}

function resolveCommandDescription(
  command: CapabilityCommand,
  workflows: readonly CapabilityWorkflow[]
): string | undefined {
  const ownDescription = command.description?.trim();
  if (ownDescription) return ownDescription;
  const workflow = workflows.find((candidate) => workflowMatchesCommand(candidate, command));
  return workflow?.description?.trim() || undefined;
}

interface SlashCommandSuggestionOptions {
  forceNamespacedAliases?: ReadonlySet<string>;
}

function shouldUseNamespacedSlash(
  command: RegisteredSlashCommand,
  options: SlashCommandSuggestionOptions = {}
): boolean {
  return (
    RESERVED_SLASH_COMMANDS.has(command.alias) ||
    options.forceNamespacedAliases?.has(command.alias) === true ||
    Boolean(command.conflictsWith?.length)
  );
}

export function collectSlashSuggestionAliases(
  suggestions: readonly MentionSuggestion[]
): Set<string> {
  const aliases = new Set<string>();
  for (const suggestion of suggestions) {
    if (!suggestion.command) continue;
    const commandName = suggestion.command.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
    if (commandName && !commandName.includes(':')) aliases.add(commandName);
  }
  return aliases;
}

export function buildSlashCommandRegistry({
  packs = [],
  scope,
}: SlashRegistryInput): RegisteredSlashCommand[] {
  const registered: RegisteredSlashCommand[] = [];

  for (const pack of packs) {
    if (!pack.enabled || pack.source === 'builtin') continue;

    const packId = pack.manifest.id;
    const namespace = normalizeNamespace(pack.manifest.namespace);
    const workflows = pack.manifest.capabilities.workflows ?? [];
    for (const command of pack.manifest.capabilities.commands ?? []) {
      const alias = normalizeAlias(command.alias);
      if (
        !alias ||
        !namespace ||
        !isRegistryToken(alias) ||
        !isRegistryToken(namespace) ||
        !commandSupportsSlash(command) ||
        !commandAppliesToScope(command, scope)
      ) {
        continue;
      }

      registered.push({
        canonicalId: `${packId}.${command.id}`,
        alias,
        namespace,
        slash: `/${alias}`,
        namespacedSlash: `/${namespace}:${alias}`,
        source: 'pack',
        packId,
        command: {
          ...command,
          alias,
          description: resolveCommandDescription(command, workflows),
          execution: command.execution ?? {
            type: scope === 'admin-loop' ? 'loop-session' : 'send-message',
            reuse: true,
          },
        },
      });
    }
  }

  const byAlias = new Map<string, RegisteredSlashCommand[]>();
  for (const command of registered) {
    byAlias.set(command.alias, [...(byAlias.get(command.alias) ?? []), command]);
  }

  return registered
    .map((command) => {
      const aliasPeers = byAlias.get(command.alias) ?? [];
      const conflictsWith = [
        ...aliasPeers
          .filter((peer) => peer.canonicalId !== command.canonicalId)
          .map((peer) => peer.canonicalId),
        ...(RESERVED_SLASH_COMMANDS.has(command.alias) ? [`official.${command.alias}`] : []),
      ];
      return conflictsWith.length ? { ...command, conflictsWith } : command;
    })
    .sort(
      (a, b) =>
        (a.command.order ?? 999) - (b.command.order ?? 999) || a.alias.localeCompare(b.alias)
    );
}

export function resolveSlashCommand(
  registry: readonly RegisteredSlashCommand[],
  input: string,
  commandRef?: string
): SlashCommandResolveResult {
  if (commandRef) {
    const command = registry.find((entry) => entry.canonicalId === commandRef);
    return command ? { status: 'resolved', command } : { status: 'not-found' };
  }

  const normalized = input.trim().replace(/^\//, '').toLowerCase();
  if (!normalized) return { status: 'not-found' };

  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    if (parts.length !== 2 || !isRegistryToken(parts[0]) || !isRegistryToken(parts[1])) {
      return { status: 'not-found' };
    }
    const [namespace, alias] = parts;
    const command = registry.find(
      (entry) => entry.namespace === namespace && entry.alias === alias
    );
    return command ? { status: 'resolved', command } : { status: 'not-found' };
  }

  const candidates = registry.filter((entry) => entry.alias === normalized);
  if (candidates.length === 0) return { status: 'not-found' };
  if (candidates.length > 1 || RESERVED_SLASH_COMMANDS.has(normalized)) {
    return { status: 'conflict', candidates };
  }
  return { status: 'resolved', command: candidates[0] };
}

export function registeredSlashCommandToSuggestion(
  registered: RegisteredSlashCommand,
  options: SlashCommandSuggestionOptions = {}
): MentionSuggestion {
  const command = shouldUseNamespacedSlash(registered, options)
    ? registered.namespacedSlash
    : registered.slash;
  const insertText = command.slice(1);
  const conflictLabel = registered.conflictsWith?.length ? ' · use namespaced command' : '';

  return {
    id: `capability-command:${registered.canonicalId}`,
    name: insertText,
    type: 'command',
    command,
    commandRef: registered.canonicalId,
    insertText,
    description: registered.command.description ?? registered.command.title,
    subtitle: `${registered.namespace} · ${registered.command.safety}${conflictLabel}`,
    searchText: [
      registered.command.title,
      registered.command.description,
      registered.alias,
      registered.namespace,
      registered.packId,
      registered.command.safety,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export function buildCapabilityPackCommandSuggestions(
  packs: readonly LoadedCapabilityPack[],
  scope: CapabilityScope,
  options: SlashCommandSuggestionOptions = {}
): MentionSuggestion[] {
  return buildSlashCommandRegistry({ packs, scope }).map((registered) =>
    registeredSlashCommandToSuggestion(registered, options)
  );
}

export function sourceLabel(source: SlashCommandSource): string {
  switch (source) {
    case 'builtin':
      return 'Built-in';
    case 'official':
      return 'Official';
    case 'project':
      return 'Project';
    case 'pack':
      return 'Capability pack';
  }
}

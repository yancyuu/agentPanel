import type { FastifyInstance, FastifyRequest } from 'fastify';

interface BridgeConfigRouteDependencies {
  readRaw(): { path: string; content: string };
  writeRaw(content: string): Promise<void>;
}

function errorPayload(error: unknown) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function parseBridgeConfig(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const dataDirMatch = /^data_dir\s*=\s*"([^"]*)"/m.exec(raw);
  if (dataDirMatch) result.data_dir = dataDirMatch[1];
  const languageMatch = /^language\s*=\s*"([^"]*)"/m.exec(raw);
  if (languageMatch) result.language = languageMatch[1];
  const idleTimeoutMatch = /^idle_timeout_mins\s*=\s*(\d+)/m.exec(raw);
  if (idleTimeoutMatch) result.idle_timeout_mins = Number(idleTimeoutMatch[1]);
  const maxTurnTimeMatch = /^max_turn_time_mins\s*=\s*(\d+)/m.exec(raw);
  if (maxTurnTimeMatch) result.max_turn_time_mins = Number(maxTurnTimeMatch[1]);
  const workspaceIdleMatch = /^workspace_idle_timeout_mins\s*=\s*(\d+)/m.exec(raw);
  if (workspaceIdleMatch) result.workspace_idle_timeout_mins = Number(workspaceIdleMatch[1]);

  const managementSection = /\[management\]([^\[]*)/s.exec(raw)?.[1];
  if (managementSection) {
    const enabled = /enabled\s*=\s*(true|false)/.exec(managementSection);
    if (enabled) result.management_enabled = enabled[1] === 'true';
    const port = /port\s*=\s*(\d+)/.exec(managementSection);
    if (port) result.management_port = Number(port[1]);
    const token = /token\s*=\s*"([^"]*)"/.exec(managementSection);
    if (token) result.management_token = token[1];
  }

  const bridgeSection = /\[bridge\]([^\[]*)/s.exec(raw)?.[1];
  if (bridgeSection) {
    const enabled = /enabled\s*=\s*(true|false)/.exec(bridgeSection);
    if (enabled) result.bridge_enabled = enabled[1] === 'true';
    const port = /port\s*=\s*(\d+)/.exec(bridgeSection);
    if (port) result.bridge_port = Number(port[1]);
    const token = /token\s*=\s*"([^"]*)"/.exec(bridgeSection);
    if (token) result.bridge_token = token[1];
  }

  const logSection = /\[log\]([^\[]*)/s.exec(raw)?.[1];
  if (logSection) {
    const level = /level\s*=\s*"([^"]*)"/.exec(logSection);
    if (level) result.log_level = level[1];
  }

  const displaySection = /\[display\]([^\[]*)/s.exec(raw)?.[1];
  if (displaySection) {
    const thinking = /thinking_messages\s*=\s*(true|false)/.exec(displaySection);
    if (thinking) result.display_thinking = thinking[1] === 'true';
    const tool = /tool_messages\s*=\s*(true|false)/.exec(displaySection);
    if (tool) result.display_tool = tool[1] === 'true';
  }
  return result;
}

function updateBridgeConfig(rawInput: string, updates: Record<string, unknown>): string {
  let raw = rawInput;
  if (updates.language !== undefined) {
    raw = raw.replace(/^(language\s*=\s*)"[^"]*"/m, `$1"${updates.language}"`);
  }
  if (updates.idle_timeout_mins !== undefined) {
    raw = raw.replace(/^(idle_timeout_mins\s*=\s*)\d+/m, `$1${updates.idle_timeout_mins}`);
  }
  if (updates.max_turn_time_mins !== undefined) {
    raw = /^max_turn_time_mins\s*=/m.test(raw)
      ? raw.replace(/^(max_turn_time_mins\s*=\s*)\d+/m, `$1${updates.max_turn_time_mins}`)
      : raw.replace(
          /^(idle_timeout_mins\s*=\s*\d+)/m,
          `$1\nmax_turn_time_mins = ${updates.max_turn_time_mins}`
        );
  }
  if (updates.workspace_idle_timeout_mins !== undefined) {
    raw = /^workspace_idle_timeout_mins\s*=/m.test(raw)
      ? raw.replace(
          /^(workspace_idle_timeout_mins\s*=\s*)\d+/m,
          `$1${updates.workspace_idle_timeout_mins}`
        )
      : raw.replace(
          /^(idle_timeout_mins\s*=\s*\d+)/m,
          `$1\nworkspace_idle_timeout_mins = ${updates.workspace_idle_timeout_mins}`
        );
  }

  if (updates.management_enabled !== undefined) {
    const value = updates.management_enabled ? 'true' : 'false';
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(enabled\s*=\s*)(true|false)/s,
      (_match, prefix: string, key: string) => `${prefix}${key}${value}`
    );
  }
  if (updates.management_port !== undefined) {
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(port\s*=\s*)\d+/s,
      `$1$2${updates.management_port}`
    );
  }
  if (updates.management_token !== undefined) {
    raw = raw.replace(
      /(\[management\][^\n]*\n(?:[^\[]*))(token\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.management_token}"`
    );
  }
  if (updates.bridge_enabled !== undefined) {
    const value = updates.bridge_enabled ? 'true' : 'false';
    raw = raw.replace(
      /(\[bridge\][^\n]*\n(?:[^\[]*))(enabled\s*=\s*)(true|false)/s,
      `$1$2${value}`
    );
  }
  if (updates.bridge_port !== undefined) {
    raw = raw.replace(
      /(\[bridge\][^\n]*\n(?:[^\[]*))(port\s*=\s*)\d+/s,
      `$1$2${updates.bridge_port}`
    );
  }
  if (updates.bridge_token !== undefined) {
    raw = raw.replace(
      /(\[bridge\][^\n]*\n(?:[^\[]*))(token\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.bridge_token}"`
    );
  }
  if (updates.log_level !== undefined) {
    raw = raw.replace(
      /(\[log\][^\n]*\n(?:[^\[]*))(level\s*=\s*)"[^"]*"/s,
      `$1$2"${updates.log_level}"`
    );
  }
  if (updates.display_thinking !== undefined) {
    const value = updates.display_thinking ? 'true' : 'false';
    raw = raw.replace(
      /(\[display\][^\n]*\n(?:[^\[]*))(thinking_messages\s*=\s*)(true|false)/s,
      `$1$2${value}`
    );
  }
  if (updates.display_tool !== undefined) {
    const value = updates.display_tool ? 'true' : 'false';
    raw = raw.replace(
      /(\[display\][^\n]*\n(?:[^\[]*))(tool_messages\s*=\s*)(true|false)/s,
      `$1$2${value}`
    );
  }
  return raw;
}

export function registerBridgeConfigRoutes(
  app: FastifyInstance,
  { readRaw, writeRaw }: BridgeConfigRouteDependencies
): void {
  const readStructured = async () => {
    try {
      const config = parseBridgeConfig(readRaw().content);
      const managementToken = config.management_token;
      if (typeof managementToken === 'string' && managementToken) {
        config.management_token = `${managementToken.slice(0, 4)}****`;
      }
      const bridgeToken = config.bridge_token;
      if (typeof bridgeToken === 'string' && bridgeToken) {
        config.bridge_token = `${bridgeToken.slice(0, 4)}****`;
      }
      return { ok: true, data: config };
    } catch (error) {
      return errorPayload(error);
    }
  };

  const writeStructured = async (request: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    try {
      const updates = request.body ?? {};
      await writeRaw(updateBridgeConfig(readRaw().content, updates));
      const needsRestart =
        'management_port' in updates ||
        'management_token' in updates ||
        'bridge_port' in updates ||
        'bridge_token' in updates;
      return { ok: true, data: { needsRestart } };
    } catch (error) {
      return errorPayload(error);
    }
  };

  const readRawHandler = async () => {
    try {
      return { ok: true, data: readRaw() };
    } catch (error) {
      return errorPayload(error);
    }
  };

  const writeRawHandler = async (request: FastifyRequest<{ Body: { content?: unknown } }>) => {
    try {
      const content = request.body?.content;
      if (typeof content !== 'string') return { ok: false, error: 'content 必须是字符串' };
      await writeRaw(content);
      return { ok: true };
    } catch (error) {
      return errorPayload(error);
    }
  };

  app.get('/api/hermit-bridge-config', readStructured);
  app.post<{ Body: Record<string, unknown> }>('/api/hermit-bridge-config', writeStructured);
  app.get('/api/hermit-bridge-config/raw', readRawHandler);
  app.post<{ Body: { content?: unknown } }>('/api/hermit-bridge-config/raw', writeRawHandler);
  app.get('/api/cc-config', readStructured);
  app.post<{ Body: Record<string, unknown> }>('/api/cc-config', writeStructured);
  app.get('/api/cc-config/raw', readRawHandler);
  app.post<{ Body: { content?: unknown } }>('/api/cc-config/raw', writeRawHandler);
}

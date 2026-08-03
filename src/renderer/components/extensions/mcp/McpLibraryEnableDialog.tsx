/**
 * McpLibraryEnableDialog — enables a global MCP template as a project instance.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { useStore } from '@renderer/store';
import { Plus, Server, Trash2 } from 'lucide-react';

import type { InstalledMcpEntry, McpHeaderDef, McpLibraryEntry } from '@shared/types/extensions';

interface McpLibraryEnableDialogProps {
  open: boolean;
  entry: McpLibraryEntry | null;
  projectPath: string | null;
  installedServers?: InstalledMcpEntry[];
  harnessType?: string;
  onClose: () => void;
  onEnabled: () => void;
}

interface EnvRow {
  key: string;
  value: string;
}

const SERVER_NAME_RE = /^[\w.-]{1,100}$/;

function summarizeMcp(entry: McpLibraryEntry): string {
  if (entry.installSpec.type === 'stdio') {
    return `stdio · ${entry.installSpec.npmPackage}${entry.installSpec.npmVersion ? `@${entry.installSpec.npmVersion}` : ''}`;
  }
  return `${entry.installSpec.transportType} · ${entry.installSpec.url}`;
}

function envRowsFromRecord(record?: Record<string, string>): EnvRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

function envRecordFromRows(rows: EnvRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map((row) => [row.key.trim(), row.value]).filter(([key]) => key.length > 0)
  );
}

function cleanHeaders(headers: McpHeaderDef[]): McpHeaderDef[] {
  return headers
    .map((header) => ({ ...header, key: header.key.trim() }))
    .filter((header) => header.key && header.value);
}

export const McpLibraryEnableDialog = ({
  open,
  entry,
  projectPath,
  installedServers = [],
  harnessType,
  onClose,
  onEnabled,
}: McpLibraryEnableDialogProps): React.JSX.Element => {
  const installCustomMcpServer = useStore((s) => s.installCustomMcpServer);
  const mcpFetchInstalled = useStore((s) => s.mcpFetchInstalled);
  const runMcpDiagnostics = useStore((s) => s.runMcpDiagnostics);

  const [serverName, setServerName] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [headers, setHeaders] = useState<McpHeaderDef[]>([]);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installedNames = useMemo(
    () => new Set(installedServers.map((server) => server.name.toLowerCase())),
    [installedServers]
  );
  const trimmedName = serverName.trim();
  const nameExists = Boolean(trimmedName) && installedNames.has(trimmedName.toLowerCase());
  const canSubmit = Boolean(entry && projectPath && trimmedName && !nameExists && !installing);

  useEffect(() => {
    if (!open || !entry) return;
    setServerName(entry.name);
    setEnvRows(envRowsFromRecord(entry.envValues));
    setHeaders(entry.headers ?? []);
    setError(null);
    setInstalling(false);
  }, [entry, open]);

  const addEnvRow = (): void => setEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeEnvRow = (index: number): void =>
    setEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateEnvRow = (index: number, field: keyof EnvRow, value: string): void =>
    setEnvRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const addHeader = (): void => setHeaders((prev) => [...prev, { key: '', value: '' }]);
  const removeHeader = (index: number): void =>
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  const updateHeader = (index: number, field: 'key' | 'value', value: string): void =>
    setHeaders((prev) =>
      prev.map((header, i) => (i === index ? { ...header, [field]: value } : header))
    );

  const handleEnable = async (): Promise<void> => {
    if (!entry || !projectPath) return;

    if (!trimmedName) {
      setError('实例名称不能为空');
      return;
    }
    if (!SERVER_NAME_RE.test(trimmedName)) {
      setError('实例名称只能包含字母、数字、下划线、短横线和点号，最多 100 个字符');
      return;
    }
    if (nameExists) {
      setError('当前项目已存在同名实例，请改用其他实例名');
      return;
    }

    setInstalling(true);
    setError(null);
    try {
      await installCustomMcpServer({
        serverName: trimmedName,
        scope: 'project',
        projectPath,
        installSpec: entry.installSpec,
        envValues: envRecordFromRows(envRows),
        headers: cleanHeaders(headers),
        harnessType: harnessType ?? 'claudecode',
      });
      await Promise.all([mcpFetchInstalled(projectPath), runMcpDiagnostics(projectPath)]);
      onEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加项目实例失败');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !installing && onClose()}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-raised">
              <Server className="size-4 text-text-muted" />
            </div>
            <div>
              <DialogTitle>添加 MCP 项目实例</DialogTitle>
              <DialogDescription>
                从全局模板创建当前项目专属实例，可覆盖实例名、环境变量和请求头。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {entry ? (
          <div className="space-y-4">
            <div className="bg-surface-raised/40 rounded-md border border-border px-3 py-2">
              <div className="text-xs font-medium text-text">模板：{entry.name}</div>
              <div className="mt-1 truncate font-mono text-[11px] text-text-muted">
                {summarizeMcp(entry)}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mcp-enable-instance-name" className="text-xs">
                项目实例名称
              </Label>
              <Input
                id="mcp-enable-instance-name"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder={entry.name}
                className="h-8 font-mono text-sm"
                autoFocus
              />
              <p
                className={
                  nameExists ? 'text-[11px] text-amber-300' : 'text-[11px] text-text-muted'
                }
              >
                {nameExists
                  ? '当前项目已存在同名实例，请改用其他实例名。'
                  : '实例名只写入当前项目，可与模板名不同。'}
              </p>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label className="text-xs">项目环境变量</Label>
                  <p className="text-[11px] text-text-muted">
                    已预填模板默认值，可按当前项目覆盖。
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={addEnvRow} className="h-7 px-2 text-xs">
                  <Plus className="mr-1 size-3" />
                  添加
                </Button>
              </div>
              {envRows.length > 0 ? (
                <div className="space-y-2">
                  {envRows.map((row, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(event) => updateEnvRow(index, 'key', event.target.value)}
                        className="h-7 w-40 font-mono text-xs"
                        placeholder="ENV_NAME"
                      />
                      <Input
                        value={row.value}
                        onChange={(event) => updateEnvRow(index, 'value', event.target.value)}
                        className="h-7 flex-1 text-xs"
                        placeholder="value"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-red-400 hover:bg-red-500/10"
                        onClick={() => removeEnvRow(index)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-text-muted">此模板没有环境变量默认值。</p>
              )}
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label className="text-xs">项目请求头</Label>
                  <p className="text-[11px] text-text-muted">HTTP/SSE 实例可用，stdio 通常忽略。</p>
                </div>
                <Button variant="ghost" size="sm" onClick={addHeader} className="h-7 px-2 text-xs">
                  <Plus className="mr-1 size-3" />
                  添加
                </Button>
              </div>
              {headers.length > 0 ? (
                <div className="space-y-2">
                  {headers.map((header, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={header.key}
                        onChange={(event) => updateHeader(index, 'key', event.target.value)}
                        className="h-7 w-40 text-xs"
                        placeholder="Header-Name"
                      />
                      <Input
                        value={header.value}
                        onChange={(event) => updateHeader(index, 'value', event.target.value)}
                        className="h-7 flex-1 text-xs"
                        placeholder="value"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-red-400 hover:bg-red-500/10"
                        onClick={() => removeHeader(index)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-text-muted">此模板没有请求头默认值。</p>
              )}
            </div>

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={installing}>
                取消
              </Button>
              <Button
                size="sm"
                className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
                disabled={!canSubmit}
                onClick={() => void handleEnable()}
              >
                {installing ? '添加中...' : '添加到当前项目'}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

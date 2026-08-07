/**
 * McpLibraryEntryDialog — create or edit reusable global MCP server definitions.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { Plus, Server, Trash2 } from 'lucide-react';

import type {
  McpHeaderDef,
  McpInstallSpec,
  McpLibraryEntry,
  McpLibraryUpsertRequest,
} from '@shared/types/extensions';

type TransportMode = 'stdio' | 'http';
type HttpTransport = 'streamable-http' | 'sse' | 'http';

interface EnvRow {
  key: string;
  value: string;
}

const HTTP_TRANSPORT_OPTIONS: { value: HttpTransport; label: string }[] = [
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'http', label: 'HTTP' },
];

interface McpLibraryEntryDialogProps {
  open: boolean;
  entry: McpLibraryEntry | null;
  onClose: () => void;
  onSaved: (entry: McpLibraryEntry) => void;
}

function envRowsFromRecord(values?: Record<string, string>): EnvRow[] {
  return Object.entries(values ?? {}).map(([key, value]) => ({ key, value }));
}

function envRecordFromRows(rows: EnvRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export const McpLibraryEntryDialog = ({
  open,
  entry,
  onClose,
  onSaved,
}: McpLibraryEntryDialogProps): React.JSX.Element => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transportMode, setTransportMode] = useState<TransportMode>('stdio');
  const [npmPackage, setNpmPackage] = useState('');
  const [npmVersion, setNpmVersion] = useState('');
  const [httpUrl, setHttpUrl] = useState('');
  const [httpTransport, setHttpTransport] = useState<HttpTransport>('streamable-http');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [headers, setHeaders] = useState<McpHeaderDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    if (justOpened) {
      setName(entry?.name ?? '');
      setDescription(entry?.description ?? '');
      setEnvRows(envRowsFromRecord(entry?.envValues));
      setHeaders(entry?.headers ?? []);
      setError(null);
      setSaving(false);

      if (!entry || entry.installSpec.type === 'stdio') {
        setTransportMode('stdio');
        setNpmPackage(entry?.installSpec.type === 'stdio' ? entry.installSpec.npmPackage : '');
        setNpmVersion(
          entry?.installSpec.type === 'stdio' ? (entry.installSpec.npmVersion ?? '') : ''
        );
        setHttpUrl('');
        setHttpTransport('streamable-http');
      } else {
        setTransportMode('http');
        setNpmPackage('');
        setNpmVersion('');
        setHttpUrl(entry.installSpec.url);
        setHttpTransport(entry.installSpec.transportType);
      }
    }
    wasOpenRef.current = open;
  }, [entry, open]);

  const canSubmit = useMemo(() => {
    if (saving || !name.trim()) return false;
    return transportMode === 'stdio' ? Boolean(npmPackage.trim()) : Boolean(httpUrl.trim());
  }, [httpUrl, name, npmPackage, saving, transportMode]);

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

  const handleSave = async (): Promise<void> => {
    if (!api.mcpRegistry?.libraryUpsert) {
      setError('MCP 能力库 API 不可用');
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('服务器名称不能为空');
      return;
    }

    let installSpec: McpInstallSpec;
    if (transportMode === 'stdio') {
      if (!npmPackage.trim()) {
        setError('npm 包名不能为空');
        return;
      }
      installSpec = {
        type: 'stdio',
        npmPackage: npmPackage.trim(),
        npmVersion: npmVersion.trim() || undefined,
      };
    } else {
      if (!httpUrl.trim()) {
        setError('服务器 URL 不能为空');
        return;
      }
      installSpec = {
        type: 'http',
        url: httpUrl.trim(),
        transportType: httpTransport,
      };
    }

    const request: McpLibraryUpsertRequest = {
      id: entry?.id,
      name: trimmedName,
      description: description.trim() || undefined,
      installSpec,
      envValues: envRecordFromRows(envRows),
      headers: headers
        .map((header) => ({ ...header, key: header.key.trim() }))
        .filter((header) => header.key && header.value),
    };

    setSaving(true);
    setError(null);
    try {
      const saved = await api.mcpRegistry.libraryUpsert(request);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 MCP 定义失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-raised">
              <Server className="size-4 text-text-muted" />
            </div>
            <div>
              <DialogTitle>{entry ? '编辑 MCP 定义' : '添加 MCP 定义'}</DialogTitle>
              <DialogDescription>保存到全局能力库后，可在不同团队项目中复用。</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-library-name" className="text-xs">
              服务器名称
            </Label>
            <Input
              id="mcp-library-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-server"
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-library-description" className="text-xs">
              描述（可选）
            </Label>
            <Textarea
              id="mcp-library-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个 MCP 服务器的用途"
              className="min-h-20 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">传输方式</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={transportMode === 'stdio' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTransportMode('stdio')}
              >
                Stdio (npm)
              </Button>
              <Button
                type="button"
                variant={transportMode === 'http' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTransportMode('http')}
              >
                HTTP / SSE
              </Button>
            </div>
          </div>

          {transportMode === 'stdio' ? (
            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-library-npm" className="text-xs">
                  npm 包
                </Label>
                <Input
                  id="mcp-library-npm"
                  value={npmPackage}
                  onChange={(event) => setNpmPackage(event.target.value)}
                  placeholder="@example/mcp-server"
                  className="h-8 font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-library-version" className="text-xs">
                  版本（可选）
                </Label>
                <Input
                  id="mcp-library-version"
                  value={npmVersion}
                  onChange={(event) => setNpmVersion(event.target.value)}
                  placeholder="latest"
                  className="h-8 text-sm"
                />
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-library-url" className="text-xs">
                  服务器 URL
                </Label>
                <Input
                  id="mcp-library-url"
                  value={httpUrl}
                  onChange={(event) => setHttpUrl(event.target.value)}
                  placeholder="https://api.example.com/mcp"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">传输类型</Label>
                <Select
                  value={httpTransport}
                  onValueChange={(value) => setHttpTransport(value as HttpTransport)}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HTTP_TRANSPORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs">环境变量默认值</Label>
                <p className="text-[11px] text-text-muted">仅保存非敏感默认值，需要时可留空。</p>
              </div>
              <Button variant="ghost" size="sm" onClick={addEnvRow} className="h-7 px-2 text-xs">
                <Plus className="mr-1 size-3" />
                添加
              </Button>
            </div>
            {envRows.length > 0 && (
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
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs">请求头</Label>
                <p className="text-[11px] text-text-muted">
                  HTTP/SSE 服务器可使用，stdio 会保留但安装时通常忽略。
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={addHeader} className="h-7 px-2 text-xs">
                <Plus className="mr-1 size-3" />
                添加
              </Button>
            </div>
            {headers.length > 0 && (
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
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button
              size="sm"
              className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
              disabled={!canSubmit}
              onClick={() => void handleSave()}
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

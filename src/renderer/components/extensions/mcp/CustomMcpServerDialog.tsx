/**
 * CustomMcpServerDialog — add a custom MCP server by providing install spec directly.
 * Supports stdio (npm package) and HTTP/SSE transports.
 */

import { useEffect, useRef, useState } from 'react';

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
import { useStore } from '@renderer/store';
import { getDefaultMcpSharedScope } from '@shared/utils/mcpScopes';
import { Plus, Server, Trash2 } from 'lucide-react';

import { HarnessSelector } from '../common/HarnessSelector';

import type {
  McpCustomInstallRequest,
  McpHeaderDef,
  McpInstallSpec,
} from '@shared/types/extensions';

const SERVER_NAME_RE = /^[\w.-]{1,100}$/;

interface CustomMcpServerDialogProps {
  open: boolean;
  onClose: () => void;
}

type TransportMode = 'stdio' | 'http';
type HttpTransport = 'streamable-http' | 'sse' | 'http';

const HTTP_TRANSPORT_OPTIONS: { value: HttpTransport; label: string }[] = [
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'http', label: 'HTTP' },
];

export const CustomMcpServerDialog = ({
  open,
  onClose,
}: CustomMcpServerDialogProps): React.JSX.Element => {
  const installCustomMcpServer = useStore((s) => s.installCustomMcpServer);
  const storedCliStatus = useStore((s) => s.cliStatus);
  const defaultSharedScope = getDefaultMcpSharedScope(storedCliStatus?.flavor);
  const installScope = defaultSharedScope === 'global' ? 'user' : defaultSharedScope;

  // Form state
  const [serverName, setServerName] = useState('');
  const [transportMode, setTransportMode] = useState<TransportMode>('stdio');
  const [harnessType, setHarnessType] = useState('claudecode');

  // Stdio fields
  const [npmPackage, setNpmPackage] = useState('');
  const [npmVersion, setNpmVersion] = useState('');

  // HTTP fields
  const [httpUrl, setHttpUrl] = useState('');
  const [httpTransport, setHttpTransport] = useState<HttpTransport>('streamable-http');
  const [headers, setHeaders] = useState<McpHeaderDef[]>([]);

  // Shared
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const wasOpenRef = useRef(false);

  // Reset on open
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    if (justOpened) {
      setServerName('');
      setTransportMode('stdio');
      setNpmPackage('');
      setNpmVersion('');
      setHttpUrl('');
      setHttpTransport('streamable-http');
      setHeaders([]);
      setError(null);
      setInstalling(false);
    }
    wasOpenRef.current = open;
  }, [open]);

  const handleInstall = async () => {
    setError(null);

    if (!serverName.trim()) {
      setError('Server name is required');
      return;
    }
    if (!SERVER_NAME_RE.test(serverName)) {
      setError('Invalid server name. Use alphanumeric characters, dashes, underscores, dots.');
      return;
    }

    let installSpec: McpInstallSpec;

    if (transportMode === 'stdio') {
      if (!npmPackage.trim()) {
        setError('npm package name is required');
        return;
      }
      installSpec = {
        type: 'stdio',
        npmPackage: npmPackage.trim(),
        npmVersion: npmVersion.trim() || undefined,
      };
    } else {
      if (!httpUrl.trim()) {
        setError('Server URL is required');
        return;
      }
      installSpec = {
        type: 'http',
        url: httpUrl.trim(),
        transportType: httpTransport,
      };
    }

    const request: McpCustomInstallRequest = {
      serverName,
      scope: installScope,
      installSpec,
      envValues: {},
      headers: headers.filter((h) => h.key.trim() && h.value.trim()),
      harnessType,
    };

    setInstalling(true);
    try {
      await installCustomMcpServer(request);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装失败');
    } finally {
      setInstalling(false);
    }
  };

  const addHeader = () => setHeaders((prev) => [...prev, { key: '', value: '' }]);
  const removeHeader = (i: number) => setHeaders((prev) => prev.filter((_, idx) => idx !== i));
  const updateHeader = (i: number, field: 'key' | 'value', val: string) =>
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, [field]: val } : h)));

  const canSubmit =
    serverName.trim() &&
    (transportMode === 'stdio' ? npmPackage.trim() : httpUrl.trim()) &&
    !installing;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] w-full max-w-lg overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface-raised">
              <Server className="size-4 text-text-muted" />
            </div>
            <div>
              <DialogTitle>添加自定义 MCP 服务器</DialogTitle>
              <DialogDescription>不通过目录，手动添加一个服务器。</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Server name */}
          <div className="space-y-1.5">
            <Label htmlFor="custom-name" className="text-xs">
              服务器名称
            </Label>
            <Input
              id="custom-name"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="my-server"
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          {/* Transport toggle */}
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

          {/* Stdio fields */}
          {transportMode === 'stdio' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="custom-npm" className="text-xs">
                  npm 包
                </Label>
                <Input
                  id="custom-npm"
                  value={npmPackage}
                  onChange={(e) => setNpmPackage(e.target.value)}
                  placeholder="@example/mcp-server"
                  className="h-8 font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-version" className="text-xs">
                  版本（可选）
                </Label>
                <Input
                  id="custom-version"
                  value={npmVersion}
                  onChange={(e) => setNpmVersion(e.target.value)}
                  placeholder="latest"
                  className="h-8 text-sm"
                />
              </div>
            </div>
          )}

          {/* HTTP fields */}
          {transportMode === 'http' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="custom-url" className="text-xs">
                  服务器 URL
                </Label>
                <Input
                  id="custom-url"
                  value={httpUrl}
                  onChange={(e) => setHttpUrl(e.target.value)}
                  placeholder="https://api.example.com/mcp"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">传输类型</Label>
                <Select
                  value={httpTransport}
                  onValueChange={(v) => setHttpTransport(v as HttpTransport)}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HTTP_TRANSPORT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Headers */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">请求头</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addHeader}
                    className="h-6 px-1.5 text-xs"
                  >
                    <Plus className="mr-1 size-3" />
                    添加
                  </Button>
                </div>
                {headers.length > 0 && (
                  <div className="max-h-32 space-y-2 overflow-y-auto">
                    {headers.map((header, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={header.key}
                          onChange={(e) => updateHeader(i, 'key', e.target.value)}
                          className="h-7 w-32 text-xs"
                          placeholder="Header-Name"
                        />
                        <Input
                          value={header.value}
                          onChange={(e) => updateHeader(i, 'value', e.target.value)}
                          className="h-7 flex-1 text-xs"
                          placeholder="value"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-red-400 hover:bg-red-500/10"
                          onClick={() => removeHeader(i)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Harness selector */}
          <HarnessSelector capability="mcp" value={harnessType} onChange={setHarnessType} />

          {/* Error */}
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              className="hover:bg-[var(--color-accent)]/90 bg-[var(--color-accent)] text-white"
              disabled={!canSubmit}
              onClick={() => void handleInstall()}
            >
              {installing ? '正在安装...' : '安装'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * AddMcpInline — creates a reusable global MCP template from a team context.
 */

import { useState } from 'react';

import { McpLibraryEntryDialog } from '@renderer/components/extensions/mcp/McpLibraryEntryDialog';
import { Button } from '@renderer/components/ui/button';

import type { McpLibraryEntry } from '@shared/types/extensions';

interface AddMcpInlineProps {
  onAdded: (entry: McpLibraryEntry) => void;
  onCancel: () => void;
}

export const AddMcpInline = ({ onAdded, onCancel }: AddMcpInlineProps): React.JSX.Element => {
  const [dialogOpen, setDialogOpen] = useState(true);

  const handleSaved = (entry: McpLibraryEntry): void => {
    setDialogOpen(false);
    onAdded(entry);
  };

  const handleClose = (): void => {
    setDialogOpen(false);
    onCancel();
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--color-border)] p-2">
        <div className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
          先保存一个全局模板，随后可为当前项目填写独立实例名和参数。
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setDialogOpen(true)}
        >
          添加模板
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs">
          取消
        </Button>
      </div>

      <McpLibraryEntryDialog
        open={dialogOpen}
        entry={null}
        onClose={handleClose}
        onSaved={handleSaved}
      />
    </>
  );
};

/**
 * HarnessSelector — dropdown for choosing which runtime harness to install into.
 * Filters available harnesses by capability (mcp / skills).
 */

import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

type HarnessCapability = 'mcp' | 'skills';

interface HarnessOption {
  value: string;
  label: string;
}

const HARNESS_OPTIONS: Record<HarnessCapability, HarnessOption[]> = {
  // MCP install is only correct for Claude Code and Cursor today. Codex/Gemini/OpenCode
  // adapters delegate to Claude's CLI and would write the wrong config, so they are not
  // offered here to avoid silently misrouting installs.
  mcp: [
    { value: 'claudecode', label: 'Claude Code' },
    { value: 'cursor', label: 'Cursor' },
  ],
  skills: [
    { value: 'claudecode', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini CLI' },
    { value: 'opencode', label: 'OpenCode' },
    { value: 'cursor', label: 'Cursor' },
  ],
};

interface HarnessSelectorProps {
  capability: HarnessCapability;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export const HarnessSelector = ({
  capability,
  value,
  onChange,
  disabled,
}: HarnessSelectorProps): React.JSX.Element => {
  const options = HARNESS_OPTIONS[capability];

  return (
    <div className="flex items-center gap-3">
      <Label className="shrink-0 text-xs text-text-muted">运行时</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue placeholder="选择运行时" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

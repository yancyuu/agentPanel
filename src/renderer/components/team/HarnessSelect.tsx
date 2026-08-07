import { ProviderBrandLogo } from '@renderer/components/common/ProviderBrandLogo';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import { HarnessBrandLogo } from './HarnessBrandLogos';
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES } from './HarnessCards';

import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

interface HarnessSelectProps {
  readonly value: HermitBridgeAgentType;
  readonly onChange: (value: HermitBridgeAgentType) => void;
  readonly className?: string;
  readonly id?: string;
}

const HARNESS_PROVIDER_MAP: Partial<
  Record<HermitBridgeAgentType, 'anthropic' | 'codex' | 'gemini' | 'opencode'>
> = {
  claudecode: 'anthropic',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

interface HarnessIconProps {
  readonly type: HermitBridgeAgentType;
  readonly className?: string;
}

const HarnessIcon = ({ type, className }: HarnessIconProps): React.JSX.Element => {
  const providerId = HARNESS_PROVIDER_MAP[type];
  if (providerId) {
    return <ProviderBrandLogo providerId={providerId} className={className} />;
  }
  // Brand logo for the non-provider harness runtimes (cursor, kimi, …, tmux).
  return <HarnessBrandLogo type={type} className={className} />;
};

const HarnessSelect = ({
  value,
  onChange,
  className,
  id,
}: HarnessSelectProps): React.JSX.Element => {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as HermitBridgeAgentType)}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ALL_AGENT_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            <div className="flex items-center gap-2">
              <HarnessIcon type={type} className="size-4 shrink-0" />
              <span>{AGENT_TYPE_LABELS[type]}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export { HARNESS_PROVIDER_MAP, HarnessIcon, HarnessSelect };

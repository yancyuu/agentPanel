import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  formatMemberLaunchDiagnosticsPayload,
  type MemberLaunchDiagnosticsPayload,
} from '@renderer/utils/memberLaunchDiagnostics';
import { Check, ClipboardList } from 'lucide-react';

interface MemberLaunchDiagnosticsButtonProps {
  payload: MemberLaunchDiagnosticsPayload;
  label?: string;
  className?: string;
  size?: 'icon' | 'sm';
}

export const MemberLaunchDiagnosticsButton = ({
  payload,
  label,
  className,
  size = label ? 'sm' : 'icon',
}: MemberLaunchDiagnosticsButtonProps): React.JSX.Element => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  // Clear the pending reset on unmount — otherwise it fires setState after the
  // component (or the vitest environment) is already torn down.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copyDiagnostics = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatMemberLaunchDiagnosticsPayload(payload));
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      setCopied(false);
    }
  };

  const icon = copied ? <Check size={13} /> : <ClipboardList size={13} />;
  const tooltip = copied ? 'Diagnostics copied' : 'Copy diagnostics';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size}
          className={className}
          title={tooltip}
          aria-label={tooltip}
          onClick={copyDiagnostics}
        >
          {icon}
          {label ? <span>{label}</span> : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Brand logos for harness runtimes that are not one of the four CliProviderId
 * providers (anthropic / codex / gemini / opencode), which already live in
 * {@link ProviderBrandLogo}.
 *
 * Each logo is a self-contained 24×24 inline SVG so the harness picker, settings
 * list, and empty-state grid all render a recognisable brand mark instead of an
 * emoji fallback.
 */

import { useId } from 'react';

import type { HermitBridgeAgentType } from '@shared/types/hermitBridge';

type BrandLogoProps = Readonly<{
  className?: string;
}>;

/** Cursor — the editor's signature pointer/arrow mark, monochrome on a dark tile. */
const CursorBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <path d="M7.6 6.2 16 11.1l-3.5.9a.6.6 0 0 0-.4.4l-.9 3.5L7.6 6.2Z" fill="#FFFFFF" />
      <path d="M11.2 16.2 10.4 13l3.6-1 .8 3.3-3.6 1Z" fill="#FFFFFF" fillOpacity="0.55" />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#2a2a2a" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Kimi (Moonshot) — crescent moon, blue→violet. */
const KimiBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M16.4 3.6a8.5 8.5 0 1 0 4 9.9 6.6 6.6 0 0 1-4-9.9Z" fill={`url(#${gradientId})`} />
      <circle cx="18.4" cy="6.4" r="1.5" fill={`url(#${gradientId})`} />
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="4"
          x2="20"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#6E8BFF" />
          <stop offset="1" stopColor="#9B6BFF" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Devin (Cognition) — bold geometric "D" node mark. */
const DevinBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M8 6.5h4.2a5.5 5.5 0 0 1 0 11H8a.5.5 0 0 1-.5-.5V7A.5.5 0 0 1 8 6.5Zm2.2 3v5a.4.4 0 0 0 .4.4h1.5a2.9 2.9 0 0 0 0-5.8h-1.5a.4.4 0 0 0-.4.4Z"
        fill="#FFFFFF"
      />
      <circle cx="9.6" cy="9.2" r="1.1" fill="#FFFFFF" fillOpacity="0.6" />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#4F6FED" />
          <stop offset="1" stopColor="#7A5AF8" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Qoder — code-bracket "Q" on a purple tile. */
const QoderBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M9.2 7.4 6.4 12l2.8 4.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.8 7.4 17.6 12l-2.8 4.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill="#FFFFFF" />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#6D28D9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Pi (Inflection) — the π glyph on a dark rounded tile. */
const PiBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M6.6 9h10.8M9.4 9c-.2 2 .0 4 .0 6.2 0 1-.5 1.6-1.3 1.6M14.6 9c.2 2 .0 4 .0 6.2 0 1 .5 1.6 1.3 1.6M12 9v8"
        fill="none"
        stroke="#F4F4F5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1f2937" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** iFlow — lowercase "i" riding a flow wave, sky blue. */
const IFlowBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <circle cx="9" cy="6.6" r="1.3" fill="#FFFFFF" />
      <path
        d="M7.6 9.4h2.8v4.4c0 1.5.7 2.4 1.9 2.4"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 13.2c1 0 1.6.9 2.7.9s1.7-.9 2.8-.9"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="1" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** ACP (Agent Client Protocol) — linked nodes. */
const AcpBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M8.2 8.2 12 12m3.8 3.8L12 12m0 0 3.8-3.8M12 12l-3.8 3.8"
        stroke="#FFFFFF"
        strokeOpacity="0.45"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="7.6" cy="7.6" r="2.1" fill="#FFFFFF" />
      <circle cx="16.4" cy="7.6" r="2.1" fill="#FFFFFF" />
      <circle cx="7.6" cy="16.4" r="2.1" fill="#FFFFFF" />
      <circle cx="16.4" cy="16.4" r="2.1" fill="#FFFFFF" />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#64748B" />
          <stop offset="1" stopColor="#334155" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** Tmux — terminal tile with a split pane, signature green. */
const TmuxBrandLogo = ({ className }: BrandLogoProps): React.JSX.Element => {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="6" fill={`url(#${gradientId})`} />
      <rect
        x="5"
        y="5"
        width="14"
        height="14"
        rx="2"
        fill="#0F1A17"
        stroke="#2BB673"
        strokeWidth="0.9"
      />
      <path d="M12 5.4v13.2" stroke="#2BB673" strokeWidth="0.9" strokeOpacity="0.6" />
      <path
        d="M7.2 9.2 9 11l-1.8 1.8"
        fill="none"
        stroke="#32D58B"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="3"
          y1="3"
          x2="21"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1b2421" />
          <stop offset="1" stopColor="#0a0f0d" />
        </linearGradient>
      </defs>
    </svg>
  );
};

interface HarnessBrandLogoProps {
  readonly type: HermitBridgeAgentType;
  readonly className?: string;
}

/**
 * Renders the brand logo for a harness runtime that is NOT one of the four
 * CliProviderId providers. Returns null for provider-backed harnesses
 * (claudecode/codex/gemini/opencode) — those use {@link ProviderBrandLogo}.
 */
export const HarnessBrandLogo = ({
  type,
  className,
}: HarnessBrandLogoProps): React.JSX.Element | null => {
  switch (type) {
    case 'cursor':
      return <CursorBrandLogo className={className} />;
    case 'kimi':
      return <KimiBrandLogo className={className} />;
    case 'devin':
      return <DevinBrandLogo className={className} />;
    case 'qoder':
      return <QoderBrandLogo className={className} />;
    case 'pi':
      return <PiBrandLogo className={className} />;
    case 'iflow':
      return <IFlowBrandLogo className={className} />;
    case 'acp':
      return <AcpBrandLogo className={className} />;
    case 'tmux':
      return <TmuxBrandLogo className={className} />;
    default:
      return null;
  }
};

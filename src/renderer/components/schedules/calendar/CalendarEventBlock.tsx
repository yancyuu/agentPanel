import React from 'react';

import { cn } from '@renderer/lib/utils';

import type { CalendarOccurrence } from './types';

// =============================================================================
// CalendarEventBlock — solid colored block like Feishu
// =============================================================================

interface CalendarEventBlockProps {
  occurrence: CalendarOccurrence;
  variant: 'week' | 'day' | 'month';
  className?: string;
  style?: React.CSSProperties;
  onClick: () => void;
}

export const CalendarEventBlock = React.memo(function CalendarEventBlock({
  occurrence,
  variant,
  className,
  style,
  onClick,
}: CalendarEventBlockProps): React.JSX.Element {
  const label = occurrence.label || '定时任务';
  const timeStr = occurrence.date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  if (variant === 'month') {
    // Month: tiny pill with colored dot
    return (
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1 overflow-hidden rounded px-1 py-px text-left transition-opacity hover:opacity-80',
          className
        )}
        style={{ backgroundColor: hexToRgba(occurrence.color, 0.12), ...style }}
        onClick={onClick}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: occurrence.color }}
        />
        <span className="truncate text-[10px] leading-tight" style={{ color: occurrence.color }}>
          {label}
        </span>
      </button>
    );
  }

  // Week / Day: solid colored block with white text (Feishu style)
  return (
    <button
      type="button"
      className={cn(
        'group relative flex w-full flex-col overflow-hidden rounded-[3px] px-1.5 py-0.5 text-left transition-opacity hover:opacity-90 focus:outline-none',
        occurrence.status === 'paused' && 'opacity-50',
        className
      )}
      style={{
        backgroundColor: occurrence.color,
        borderLeft: `3px solid ${occurrence.color}`,
        filter: `saturate(0.85) brightness(1.05)`,
        ...style,
      }}
      onClick={onClick}
      title={`${label} · ${occurrence.teamDisplayName}\n${timeStr}`}
    >
      <span className="truncate text-[11px] font-medium leading-tight text-white/95">{label}</span>
      {variant === 'day' && (
        <span className="truncate text-[10px] leading-tight text-white/70">
          {occurrence.teamDisplayName}
        </span>
      )}
      {variant === 'week' && (
        <span className="truncate text-[9px] leading-tight text-white/60">
          {timeStr} · {occurrence.teamDisplayName}
        </span>
      )}
    </button>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith('hsl')) {
    return color.replace(/^hsla?\(/, 'hsla(').replace(/\)$/, `, ${alpha})`);
  }
  if (color.startsWith('rgb')) {
    return color.replace(/^rgba?\(/, 'rgba(').replace(/\)$/, `, ${alpha})`);
  }
  const hex = color.replace('#', '');
  let r: number, g: number, b: number;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length >= 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return `rgba(128, 128, 128, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

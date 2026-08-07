/**
 * SettingsSelect - Custom dropdown select component with styled dropdown menu.
 * Avoids browser default select styling for a consistent dark theme experience.
 */

import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

interface SettingsSelectProps<T extends string | number> {
  readonly value: T;
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly dropUp?: boolean;
  /** When true, trigger spans full width and dropdown aligns left */
  readonly fullWidth?: boolean;
}

export const SettingsSelect = <T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  dropUp = false,
  fullWidth = false,
}: SettingsSelectProps<T>): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Find current label
  const currentLabel = options.find((opt) => opt.value === value)?.label ?? 'Select...';

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (optionValue: T): void => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex h-8 items-center justify-between gap-2 rounded-lg border bg-transparent px-2.5 text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-border)] ${fullWidth ? 'w-full' : 'min-w-[140px]'} ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-[var(--color-border)]'} ${isOpen ? 'border-[var(--color-accent-border)] ring-1 ring-[var(--color-accent-border)]' : ''} `}
        style={{
          color: 'var(--color-text-secondary)',
          borderColor: isOpen ? undefined : 'var(--color-border-subtle)',
        }}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={`size-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: 'var(--color-text-muted)' }}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className={`absolute z-50 min-w-max overflow-hidden rounded-lg border py-1 shadow-xl shadow-black/30 duration-150 animate-in fade-in zoom-in-95 ${fullWidth ? 'inset-x-0' : 'right-0'} ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1.5'}`}
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            borderColor: 'var(--color-border-subtle)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.3), 0 0 18px var(--color-accent-glow)',
          }}
        >
          <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent-border)] to-transparent" />
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 ${
                value === option.value
                  ? 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-accent-soft)]'
              } `}
            >
              <span className="whitespace-nowrap">{option.label}</span>
              {value === option.value && (
                <Check className="size-3.5 shrink-0 text-[var(--color-accent)]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

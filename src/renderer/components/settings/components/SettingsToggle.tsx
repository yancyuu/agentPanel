/**
 * SettingsToggle - Toggle switch component for boolean settings.
 * Linear-style design with white thumb and focus ring.
 */

interface SettingsToggleProps {
  readonly enabled: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
}

export const SettingsToggle = ({
  enabled,
  onChange,
  disabled = false,
}: SettingsToggleProps): React.JSX.Element => {
  const handleClick = (): void => {
    if (!disabled) {
      onChange(!enabled);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={handleClick}
      className="relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-all duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-border)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] active:scale-95"
      style={{
        backgroundColor: enabled ? 'var(--color-accent)' : '#3f3f46',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: enabled ? '0 0 10px var(--color-accent-glow)' : 'none',
      }}
    >
      <span
        className="pointer-events-none inline-block size-[18px] rounded-full bg-white shadow-sm ring-0 transition-all duration-200 ease-out"
        style={{
          transform: enabled ? 'translateX(18px)' : 'translateX(0)',
        }}
      />
    </button>
  );
};

import { selectDesktopDefaultHarness } from '@renderer/components/team/dialogs/desktopHarnessDefault';
import { describe, expect, it } from 'vitest';

describe('selectDesktopDefaultHarness', () => {
  it('keeps the existing CLI behavior outside packaged desktop mode', () => {
    expect(
      selectDesktopDefaultHarness([
        { type: 'pi', available: true, bundled: true, desktopManaged: false },
      ])
    ).toBeNull();
  });

  it('prefers Claude Code, then Codex, then bundled Pi', () => {
    expect(
      selectDesktopDefaultHarness([
        { type: 'claudecode', available: true, desktopManaged: true },
        { type: 'codex', available: true, desktopManaged: true },
        { type: 'pi', available: true, bundled: true, desktopManaged: true },
      ])
    ).toBe('claudecode');

    expect(
      selectDesktopDefaultHarness([
        { type: 'claudecode', available: false, desktopManaged: true },
        { type: 'codex', available: true, desktopManaged: true },
        { type: 'pi', available: true, bundled: true, desktopManaged: true },
      ])
    ).toBe('codex');

    expect(
      selectDesktopDefaultHarness([
        { type: 'claudecode', available: false, desktopManaged: true },
        { type: 'codex', available: false, desktopManaged: true },
        { type: 'pi', available: true, bundled: true, desktopManaged: true },
      ])
    ).toBe('pi');
  });
});

import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { PRODUCT_NAME } from '@shared/constants';
import { Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useSettingsConfig, useSettingsHandlers } from './hooks';
import { AdvancedSection, GeneralSection, HarnessSection, PluginsSection } from './sections';
import { SETTINGS_CATEGORIES, type SettingsSection, SettingsTabs } from './SettingsTabs';

const COMPACT_NAVIGATION_WIDTH = 720;

function useCompactSettingsNavigation(
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = (width: number): void => {
      setCompact(width < COMPACT_NAVIGATION_WIDTH);
    };
    const measureContainer = (): void => {
      updateWidth(container.getBoundingClientRect().width);
    };

    measureContainer();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateWidth(entry.contentRect.width);
    });
    observer.observe(container);
    window.addEventListener('resize', measureContainer);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measureContainer);
    };
  }, [containerRef, enabled]);

  return compact;
}

export const SettingsView = (): React.JSX.Element | null => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const pageRef = useRef<HTMLDivElement>(null);
  const { pendingSettingsSection, clearPendingSettingsSection } = useStore(
    useShallow((s) => ({
      pendingSettingsSection: s.pendingSettingsSection,
      clearPendingSettingsSection: s.clearPendingSettingsSection,
    }))
  );

  useEffect(() => {
    if (pendingSettingsSection) {
      const nextSection: SettingsSection =
        pendingSettingsSection === 'harness' ||
        pendingSettingsSection === 'plugins' ||
        pendingSettingsSection === 'advanced'
          ? pendingSettingsSection
          : 'general';
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pending navigation intentionally synchronizes the local category once
      setActiveSection(nextSection);
      clearPendingSettingsSection();
    }
  }, [pendingSettingsSection, clearPendingSettingsSection]);

  const {
    config,
    safeConfig,
    loading,
    saving,
    error,
    setError,
    setSaving,
    setConfig,
    setOptimisticConfig,
    updateConfig,
  } = useSettingsConfig();

  const handlers = useSettingsHandlers({
    config,
    setSaving,
    setError,
    setConfig,
    setOptimisticConfig,
    updateConfig,
  });
  const compactNavigation = useCompactSettingsNavigation(pageRef, !loading && Boolean(config));

  const activeCategory = useMemo(
    () => SETTINGS_CATEGORIES.find((category) => category.id === activeSection)!,
    [activeSection]
  );

  if (loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div className="flex items-center gap-3 text-[var(--color-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-xs">正在加载设置…</span>
        </div>
      </div>
    );
  }

  if (error && !config) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div className="text-center">
          <p className="mb-4 text-xs text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div
      ref={pageRef}
      data-settings-layout={compactNavigation ? 'compact' : 'rail'}
      className="flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-surface)]"
    >
      <div className="mx-auto min-h-full w-full max-w-[1120px] px-4 py-5 sm:p-6">
        <header className="border-b border-[var(--color-border)] pb-5">
          <h1 className="text-base font-semibold text-[var(--color-text)]">设置</h1>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--color-text-muted)]">
            管理 {PRODUCT_NAME} 的偏好、Agent 运行时与本地服务。
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-xs text-red-400">
              {error}
            </p>
          ) : null}
        </header>

        <div className={compactNavigation ? 'mt-5 min-w-0' : 'mt-6 flex min-w-0 items-start gap-8'}>
          <div className={compactNavigation ? 'min-w-0' : 'sticky top-5 shrink-0'}>
            <SettingsTabs
              activeSection={activeSection}
              compact={compactNavigation}
              onSectionChange={setActiveSection}
            />
          </div>

          <main className={`${compactNavigation ? 'mt-5' : ''} min-w-0 max-w-3xl flex-1`}>
            {SETTINGS_CATEGORIES.map((category) => {
              const isActive = category.id === activeSection;

              return (
                <section
                  key={category.id}
                  id={`settings-panel-${category.id}`}
                  role="tabpanel"
                  aria-labelledby={`settings-tab-${category.id}`}
                  hidden={!isActive}
                  className="min-w-0"
                >
                  {isActive ? (
                    <>
                      <div className="border-b border-[var(--color-border)] pb-4">
                        <h2 className="text-sm font-semibold text-[var(--color-text)]">
                          {activeCategory.label}
                        </h2>
                        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                          {activeCategory.description}
                        </p>
                      </div>

                      <div className="mt-5 min-w-0 duration-150 animate-in fade-in">
                        {activeSection === 'general' && (
                          <GeneralSection
                            safeConfig={safeConfig}
                            saving={saving}
                            onGeneralToggle={handlers.handleGeneralToggle}
                            onThemeChange={handlers.handleThemeChange}
                            onLanguageChange={handlers.handleLanguageChange}
                          />
                        )}

                        {activeSection === 'harness' && <HarnessSection />}

                        {activeSection === 'plugins' && (
                          <PluginsSection
                            onOpenExternalChannels={() => setActiveSection('advanced')}
                          />
                        )}

                        {activeSection === 'advanced' && (
                          <AdvancedSection
                            saving={saving}
                            onResetToDefaults={handlers.handleResetToDefaults}
                            onExportConfig={handlers.handleExportConfig}
                            onImportConfig={handlers.handleImportConfig}
                            onOpenInEditor={handlers.handleOpenInEditor}
                          />
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
              );
            })}
          </main>
        </div>
      </div>
    </div>
  );
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/renderer/index.html',
    './src/renderer/**/*.{js,ts,jsx,tsx}',
    './src/features/**/*.{js,ts,jsx,tsx}',
    './src/shared/**/*.{js,ts,jsx,tsx}',
    './packages/agent-graph/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Canonical workbench surface hierarchy.
        'app-shell': 'var(--app-shell)',
        'page-canvas': 'var(--page-canvas)',
        foreground: 'var(--foreground)',
        'foreground-secondary': 'var(--foreground-secondary)',
        'muted-foreground': 'var(--muted-foreground)',
        brand: 'rgb(var(--brand-rgb) / <alpha-value>)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        destructive: 'rgb(var(--destructive-rgb) / <alpha-value>)',
        // Keep the established surface utilities stable for untouched pages.
        surface: {
          DEFAULT: 'var(--color-surface)',
          raised: 'var(--color-surface-raised)',
          overlay: 'var(--color-surface-overlay)',
          sidebar: 'var(--color-surface-sidebar)',
          code: 'var(--code-bg)',
        },
        // New shell surfaces use distinct names so existing elevation remains unchanged.
        'workbench-surface': {
          DEFAULT: 'var(--surface)',
          raised: 'var(--surface-raised)',
          hover: 'var(--surface-hover)',
          selected: 'var(--surface-selected)',
        },
        // Theme-aware border colors (use CSS variables)
        border: {
          DEFAULT: 'var(--color-border)',
          subtle: 'var(--color-border-subtle)',
          emphasis: 'var(--color-border-emphasis)',
        },
        // Theme-aware accent color
        accent: 'var(--color-accent)',
        // Theme-aware text colors (use CSS variables)
        text: {
          DEFAULT: 'var(--color-text)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        // Semantic colors (only for status, not containers)
        semantic: {
          success: 'var(--success)',
          error: 'var(--destructive)',
          warning: 'var(--warning)',
          info: 'var(--info)',
        },
        // Theme-aware info color (use for blue informational elements)
        info: {
          DEFAULT: 'var(--info-text)',
          bg: 'var(--info-bg)',
          border: 'var(--info-border)',
        },
        // Theme-aware colors using CSS variables
        // These aliases enable all existing components to automatically support light/dark mode
        'claude-dark': {
          bg: 'var(--color-surface)',
          surface: 'var(--color-surface-raised)',
          border: 'var(--color-border)',
          text: 'var(--color-text)',
          'text-secondary': 'var(--color-text-secondary)'
        }
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      boxShadow: {
        surface: 'var(--surface-shadow)',
        floating: 'var(--floating-shadow)',
      },
    }
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('tailwindcss-animate')
  ]
}

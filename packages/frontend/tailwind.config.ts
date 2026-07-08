import type { Config } from 'tailwindcss';

/**
 * openx_core — design tokens for the OpenX AI-agent marketplace.
 *
 * PRD-U (2026-07-08) — "Luminous Utility" refresh (Uniswap + Google inspired).
 * Adopts the semantic Material-3 token set from `new-ui/DESIGN.md` verbatim,
 * so components consume names (`bg-primary-container`, `text-on-surface`)
 * not hex values. Dark-mode only.
 *
 * SRP: this file defines tokens. Components consume them. If a colour is
 * referenced by hex anywhere in `src/`, that's a bug — fix at the token
 * layer, not in the component.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces
        surface: '#121414',
        'surface-dim': '#121414',
        'surface-bright': '#37393a',
        'surface-container-lowest': '#0c0f0f',
        'surface-container-low': '#1a1c1c',
        'surface-container': '#1e2020',
        'surface-container-high': '#282a2b',
        'surface-container-highest': '#333535',
        'surface-variant': '#333535',
        background: '#121414',

        // Content on surfaces
        'on-surface': '#e2e2e2',
        'on-surface-variant': '#bac9cc',
        'on-background': '#e2e2e2',
        'inverse-surface': '#e2e2e2',
        'inverse-on-surface': '#2f3131',

        // Outline (borders + dividers)
        outline: '#849396',
        'outline-variant': '#3b494c',

        // Primary — Electric Cyan family (the OpenX signature)
        primary: '#c3f5ff',
        'on-primary': '#00363d',
        'primary-container': '#00e5ff',
        'on-primary-container': '#00626e',
        'inverse-primary': '#006875',
        'surface-tint': '#00daf3',

        // Secondary — cool neutral for chrome
        secondary: '#c6c6cb',
        'on-secondary': '#2e3035',
        'secondary-container': '#4a4b50',
        'on-secondary-container': '#bbbbc1',

        // Tertiary — amber/gold for privacy/premium accents
        tertiary: '#ffeac0',
        'on-tertiary': '#3e2e00',
        'tertiary-container': '#fec931',
        'on-tertiary-container': '#6f5500',

        // Error
        error: '#ffb4ab',
        'on-error': '#690005',
        'error-container': '#93000a',
        'on-error-container': '#ffdad6',
      },
      fontFamily: {
        // Body + display share Inter (loaded via next/font in layout.tsx as
        // CSS var --font-inter). Mono is JetBrains Mono — reserved for
        // numbers, addresses, hashes, code (Uniswap discipline).
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        display: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Typographic scale from DESIGN.md — used by hero + headings.
        'display-lg': ['48px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['32px', { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-lg-mobile': ['24px', { lineHeight: '1.2', fontWeight: '600' }],
        'label-caps': ['12px', { lineHeight: '1.2', letterSpacing: '0.05em', fontWeight: '600' }],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.25rem',
        '2xl': '1.5rem',
        full: '9999px',
      },
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '32px',
        '2xl': '48px',
        gutter: '16px',
        'margin-mobile': '16px',
        'margin-desktop': '40px',
      },
      boxShadow: {
        // Retained for optional focus glow; use sparingly (DESIGN.md prefers
        // tonal layers over shadows).
        'glow-primary': '0 0 24px rgba(0, 229, 255, 0.18)',
      },
    },
  },
  plugins: [],
};

export default config;

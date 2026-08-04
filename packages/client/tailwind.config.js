/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', 'Sora', 'system-ui', 'sans-serif'],
        sans: ['Sora', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Chrome / panel colors (intentionally NOT themed — these are the
        // dark UI shell that stays consistent across themes)
        space: {
          950: '#05030f',
          900: '#0a0820',
          800: '#11102e',
          700: '#1a1840',
          600: '#26224f',
          500: '#3a3370',
        },
        // Themed accent colors — backed by CSS variables that the theme
        // loader updates at runtime. Multiple shade names all collapse to
        // a single theme color (themes don't need full shade ramps).
        plasma: {
          400: 'rgb(var(--rgb-accent) / <alpha-value>)',
          500: 'rgb(var(--rgb-accent) / <alpha-value>)',
          600: 'rgb(var(--rgb-accent) / <alpha-value>)',
        },
        cosmos: {
          300: 'rgb(var(--rgb-accent2) / <alpha-value>)',
          400: 'rgb(var(--rgb-accent2) / <alpha-value>)',
          500: 'rgb(var(--rgb-accent2) / <alpha-value>)',
          600: 'rgb(var(--rgb-accent2) / <alpha-value>)',
        },
        aurora: {
          400: 'rgb(var(--rgb-win) / <alpha-value>)',
          500: 'rgb(var(--rgb-win) / <alpha-value>)',
          600: 'rgb(var(--rgb-win) / <alpha-value>)',
        },
        nebula: {
          400: 'rgb(var(--rgb-crash) / <alpha-value>)',
          500: 'rgb(var(--rgb-crash) / <alpha-value>)',
          600: 'rgb(var(--rgb-crash) / <alpha-value>)',
        },
        solar: {
          400: 'rgb(var(--rgb-gold) / <alpha-value>)',
          500: 'rgb(var(--rgb-gold) / <alpha-value>)',
          600: 'rgb(var(--rgb-gold) / <alpha-value>)',
        },
      },
      boxShadow: {
        'panel': '0 1px 0 rgba(255,255,255,0.04) inset, 0 0 0 1px rgba(255,255,255,0.04)',
        'plasma': '0 0 24px rgb(var(--rgb-accent) / 0.35)',
        'aurora': '0 0 24px rgb(var(--rgb-win) / 0.35)',
        'nebula': '0 0 28px rgb(var(--rgb-crash) / 0.4)',
      },
      borderRadius: {
        'panel': '12px',
        'control': '8px',
      },
    },
  },
  plugins: [],
};

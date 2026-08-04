/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Poppins — a geometric sans; heavy weights carry the display role.
        // JetBrains Mono keeps the climbing multiplier and history figures
        // tabular (no width jitter) — a deliberate deviation.
        display: ['Poppins', 'system-ui', 'sans-serif'],
        sans: ['Poppins', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Chrome — iMoon indigo-black ramp (sampled from imoon.com: body #110c20,
        // header #1f1933). Stays consistent across per-game themes.
        space: {
          950: '#0b0717', // deepest wells / insets
          900: '#110c20', // page background
          850: '#161027', // sunken rows
          800: '#1a1430', // panels
          700: '#1f1933', // raised / header
          600: '#2a2440', // borders / hover
          500: '#3b3457', // subtle dividers
        },
        // Fixed iMoon chrome palette — consistent across every game (only the
        // canvas art below is per-game themed). Sampled from imoon.com.
        brand: { 300: '#ffa866', 400: '#ff8a3d', 500: '#fb6514', 600: '#e5550a' }, // orange: primary / brand
        info:  { 300: '#5aa6f0', 400: '#2f8ee8', 500: '#0c70db', 600: '#0a5cb8' }, // blue: secondary
        bet:   { 400: '#2fbf5a', 500: '#22a04a', 600: '#1b8a3f' },                 // green: place bet
        cash:  { 400: '#ffbc4a', 500: '#f5a623', 600: '#dc8f12' },                 // amber: cashout
        loss:  { 400: '#f0666b', 500: '#e5484d', 600: '#c93b40' },                 // red: crash / loss
        // Themed accents — CSS-var backed so the per-game theme loader overrides
        // them at runtime. Defaults (set in index.css) follow iMoon:
        //   accent  = orange #fb6514 (primary / brand)
        //   accent2 = blue   #0c70db (secondary / info)
        //   win     = green  #22a04a (place bet / positive)
        //   crash   = red    #e5484d
        //   gold    = amber  #f5a623 (cashout)
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
        // Fixed chrome glows (iMoon palette) — consistent across games. `plasma`
        // now means the brand orange glow; names kept so existing refs resolve.
        'panel': '0 8px 24px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05)',
        'raised': '0 12px 32px -14px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
        'plasma': '0 8px 22px -8px rgba(251,101,20,0.55)',  // orange (brand)
        'aurora': '0 8px 22px -8px rgba(34,160,74,0.5)',    // green (bet)
        'solar':  '0 8px 22px -8px rgba(245,166,35,0.5)',   // amber (cashout)
        'nebula': '0 8px 26px -8px rgba(229,72,77,0.5)',    // red (crash)
      },
      borderRadius: {
        'panel': '16px',
        'control': '10px',
      },
    },
  },
  plugins: [],
};

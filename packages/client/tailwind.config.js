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
        // Chrome — PURE NEUTRAL greyscale, hsl(0 0% L): black page, lighter panels.
        // Only lightness varies; no hue, no saturation.
        space: {
          950: 'hsl(0 0% 3%)',  // deepest wells / insets
          900: 'hsl(0 0% 5%)',  // page background (near-black)
          850: 'hsl(0 0% 7%)',  // sunken rows
          800: 'hsl(0 0% 10%)', // panels
          700: 'hsl(0 0% 14%)', // raised / header
          600: 'hsl(0 0% 20%)', // borders / hover
          500: 'hsl(0 0% 30%)', // subtle dividers
        },
        // Fixed chrome accents, in HSL — consistent across every game (only the
        // canvas art below is per-game themed).
        brand: { 300: 'hsl(26 100% 70%)', 400: 'hsl(24 100% 62%)', 500: 'hsl(21 97% 53%)', 600: 'hsl(21 92% 47%)' }, // orange: primary
        info:  { 300: 'hsl(210 83% 65%)', 400: 'hsl(209 80% 55%)', 500: 'hsl(211 90% 45%)', 600: 'hsl(212 90% 38%)' }, // blue: secondary
        bet:   { 400: 'hsl(138 61% 47%)', 500: 'hsl(139 65% 38%)', 600: 'hsl(139 67% 32%)' },                          // green: place bet
        cash:  { 400: 'hsl(38 100% 65%)', 500: 'hsl(37 91% 55%)', 600: 'hsl(37 85% 47%)' },                            // amber: cashout
        loss:  { 400: 'hsl(358 82% 67%)', 500: 'hsl(358 75% 59%)', 600: 'hsl(358 57% 51%)' },                          // red: crash
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
        'panel': '0 8px 24px -12px hsl(0 0% 0% / 0.7), 0 0 0 1px hsl(0 0% 100% / 0.05)',
        'raised': '0 12px 32px -14px hsl(0 0% 0% / 0.8), inset 0 1px 0 hsl(0 0% 100% / 0.06)',
        'plasma': '0 8px 22px -8px hsl(21 97% 53% / 0.55)', // orange (brand)
        'aurora': '0 8px 22px -8px hsl(139 65% 38% / 0.5)', // green (bet)
        'solar':  '0 8px 22px -8px hsl(37 91% 55% / 0.5)',  // amber (cashout)
        'nebula': '0 8px 26px -8px hsl(358 75% 59% / 0.5)', // red (crash)
      },
      borderRadius: {
        'panel': '16px',
        'control': '10px',
      },
    },
  },
  plugins: [],
};

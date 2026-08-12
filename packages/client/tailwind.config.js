/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Poppins everywhere — one geometric sans; heavy weights carry the
        // display role. No monospace (font-mono maps to Poppins too).
        display: ['Poppins', 'system-ui', 'sans-serif'],
        sans: ['Poppins', 'system-ui', 'sans-serif'],
        mono: ['Poppins', 'system-ui', 'sans-serif'],
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
        brand: { 300: '#ffa866', 400: '#ff8a3d', 500: '#fb6514', 600: '#e5550a' }, // PRIMARY — exact #fb6514
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
      borderRadius: {
        'panel': '16px',
        'control': '10px',
        // Terminal scale — tighter than the game HUD's. Concentric: a btn (8)
        // inside a card (12) with 4px padding lines up exactly.
        'card': '12px',
        'btn': '8px',
        'chip': '6px',
      },
      // Edges are the ONLY depth strategy in the lobby/simulate chrome: no
      // shadows (they don't read on near-black), no surface gradients. Low-alpha
      // white so a border defines an edge without becoming a visible line.
      borderColor: {
        'edge': 'rgb(255 255 255 / 0.08)',
        'edge-soft': 'rgb(255 255 255 / 0.05)',
        'edge-strong': 'rgb(255 255 255 / 0.14)',
      },
      transitionTimingFunction: {
        // Entering / interactive. Never ease-in — it stalls the first frame,
        // which is the frame the user is watching.
        'snap': 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    },
  },
  plugins: [],
};

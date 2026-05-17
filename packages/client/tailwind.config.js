/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: {
          900: '#0a0a1a',
          800: '#12122a',
          700: '#1a1a3e',
          600: '#2a2a5a',
        },
        neon: {
          green: '#00e676',
          red: '#ff1744',
          orange: '#ff9100',
          purple: '#6c5ce7',
          pink: '#fd79a8',
        },
      },
    },
  },
  plugins: [],
};

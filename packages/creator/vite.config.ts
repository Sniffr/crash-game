import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // Proxy so "Publish to server" hits the game server same-origin (no CORS).
    proxy: {
      '/admin': 'http://localhost:3001',
      '/api': 'http://localhost:3001',
    },
  },
});

import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * SimBet is a second site in this client, served on its own host
 * (simbet.games.soa.plus in production, simbet.localhost in dev). In dev, send
 * that host's page routes to simbet.html — the production server does the
 * same by Host header (packages/server/src/http/public.ts).
 *
 * Dev-only escape hatch for hosts you can't name (e.g. http://[::1]:5173):
 * `?site=simbet` switches this browser to SimBet (remembered in a cookie),
 * `?site=hub` switches back.
 */
function simBetHost(): Plugin {
  return {
    name: 'simbet-host',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = req.headers.host ?? '';
        const url = req.url ?? '/';
        const [pathname, search = ''] = url.split('?');
        const site = new URLSearchParams(search).get('site');
        if (site === 'simbet') res.setHeader('Set-Cookie', 'simbet_site=1; Path=/; SameSite=Lax');
        if (site === 'hub') res.setHeader('Set-Cookie', 'simbet_site=; Path=/; Max-Age=0; SameSite=Lax');
        const cookie = /(?:^|;\s*)simbet_site=1/.test(req.headers.cookie ?? '');
        const wantsSimBet = host.startsWith('simbet.') || site === 'simbet' || (site !== 'hub' && cookie);
        const isPage = !pathname!.startsWith('/api') && !pathname!.startsWith('/ws') && !pathname!.startsWith('/@')
          && !pathname!.startsWith('/src/') && !pathname!.startsWith('/node_modules/') && !/\.[a-z0-9]+$/i.test(pathname!);
        if (wantsSimBet && isPage) req.url = '/simbet.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), simBetHost()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        simbet: resolve(__dirname, 'simbet.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});

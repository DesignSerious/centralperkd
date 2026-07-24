import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Multi-page Vite setup: tv.html and phone.html each get their own entry,
// so they ship only the code they need. The Express server in /server
// owns the URLs /tv and /join and serves the built HTML for those routes.
//
// In dev, this Vite server runs on 5173 and proxies /socket.io to the
// Express server on 3000 so realtime works without CORS gymnastics.

// Mirror the Express URL mapping (/tv → tv.html, /join → phone.html,
// /playlist → playlist.html) in dev so the same friendly URLs work whether
// you load via Vite or via Express.
const friendlyUrlRewrites = {
  name: 'friends-trivia-friendly-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const u = req.url.split('?')[0];
      if (u === '/tv' || u === '/tv/') req.url = '/tv.html' + req.url.slice(u.length);
      else if (u === '/join' || u === '/join/') req.url = '/phone.html' + req.url.slice(u.length);
      else if (u === '/playlist' || u === '/playlist/') req.url = '/playlist.html' + req.url.slice(u.length);
      else if (u === '/sounds' || u === '/sounds/') req.url = '/sounds.html' + req.url.slice(u.length);
      else if (u === '/admin' || u === '/admin/') req.url = '/admin.html' + req.url.slice(u.length);
      next();
    });
  }
};

export default defineConfig({
  root: 'client',
  plugins: [react(), friendlyUrlRewrites],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'client/index.html'),
        tv: resolve(__dirname, 'client/tv.html'),
        phone: resolve(__dirname, 'client/phone.html'),
        playlist: resolve(__dirname, 'client/playlist.html'),
        sounds: resolve(__dirname, 'client/sounds.html'),
        admin: resolve(__dirname, 'client/admin.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
      // AI-generated piece PNGs are written + served by the Express server.
      // Without this, Vite's SPA fallback returns index.html for the <img>
      // src and the piece shows as a broken image in dev.
      '/ai-pieces': { target: 'http://localhost:3000' },
      // Uploaded, operator-assignable game sounds — served by Express.
      '/sfx-audio': { target: 'http://localhost:3000' }
    }
  }
});

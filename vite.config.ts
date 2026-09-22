import { defineConfig } from 'vite';

// The client lives in /client. In dev, Vite proxies /ws to the game server
// so both tabs talk to the same Node process.
const SERVER_PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
});

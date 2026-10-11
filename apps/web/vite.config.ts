import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the site and proxies everything else to the BSA server, so the page,
// the API, the relay socket and the session cookie all share one origin (as in production,
// where the server serves the built site itself).
const server = process.env.BSA_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '^/(auth|oauth|mcp|x402|events|api|age|health)': { target: server, changeOrigin: false },
      '/.well-known': { target: server, changeOrigin: false },
      '/relay': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: { include: ['test/**/*.test.ts'] },
});

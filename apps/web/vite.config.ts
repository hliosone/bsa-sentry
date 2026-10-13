import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// In dev, Vite serves the site and proxies everything else to the BSA server, so the page,
// the API, the relay socket and the session cookie all share one origin (as in production,
// where the server serves the built site itself).
const server = process.env.BSA_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  // The Key Ring SDK needs Node built-ins (Buffer, crypto) in the browser; the DMK does not.
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events', 'process'], globals: { Buffer: true, process: true } })],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '^/(auth|oauth|mcp|x402|events|activity|topup|shops|api|age|vault|health)': { target: server, changeOrigin: false },
      '/.well-known': { target: server, changeOrigin: false },
      '/relay': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: { include: ['test/**/*.test.ts'] },
});

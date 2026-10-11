import { defineConfig } from '@playwright/test';

// One worker: the test file starts the real BSA server, the merchants and Vite itself, and
// drives them in order. Uses the installed Google Chrome (WebHID is Chrome-only anyway).
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 120_000,
  use: { channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 } },
  reporter: [['list']],
});

import { defineConfig } from 'vitest/config';

// Speculos tests talk to one emulator over HTTP, so they must not run in parallel.
// The 60 s on-device timeout means individual tests can legitimately take minutes.
export default defineConfig({
  test: {
    include: ['test/speculos/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});

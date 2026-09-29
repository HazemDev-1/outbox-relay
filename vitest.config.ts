import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests start real HTTP servers and child processes.
    testTimeout: 20_000,
  },
});

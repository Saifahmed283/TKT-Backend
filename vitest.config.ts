import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests hit a remote Neon branch; each request opens one
    // transaction, so allow enough time for multi-request setup flows.
    testTimeout: 300000,
    hookTimeout: 300000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
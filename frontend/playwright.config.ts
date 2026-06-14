import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
  },
  // Expects the Vite dev server and Firebase emulators to already be running
  // (via start-local.sh) before tests run.
})

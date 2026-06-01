import { defineConfig } from '@playwright/test';

const apiBase =
  process.env.ADMIN_API_URL?.replace(/\/$/, '') ||
  'https://tg-networking-nhatrang.albertkoall.workers.dev';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: apiBase,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
});

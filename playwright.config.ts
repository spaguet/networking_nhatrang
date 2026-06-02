import { defineConfig } from '@playwright/test';
import { getStagingApiUrl } from './tests/helpers/integration-env';

const apiBase = getStagingApiUrl();

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    // Integration specs build full URLs via getStagingApiUrl(); baseURL is a fallback only.
    baseURL: apiBase ?? 'http://127.0.0.1:1',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },
});

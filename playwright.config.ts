import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.TIANGONG_E2E_BASE_URL ?? 'http://127.0.0.1:17456',
    channel: 'chrome',
    headless: true,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
});

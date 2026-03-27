import { defineConfig, devices } from '@playwright/test';

const usePerfProfile = process.env.PW_PERF_PROFILE === '1';
const baseURL = usePerfProfile ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:3000';
const webServerCommand = usePerfProfile
  ? 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173'
  : 'npm run dev';
const reporter = process.env.PW_REPORTER || 'line';

/**
 * Playwright configuration for Budget Tracker Elite E2E tests
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter,
  timeout: 60000,

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 10000,
    actionTimeout: 10000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 300 * 1000,
  },
});

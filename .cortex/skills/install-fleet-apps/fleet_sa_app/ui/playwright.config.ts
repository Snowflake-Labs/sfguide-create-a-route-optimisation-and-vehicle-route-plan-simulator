import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E configuration - Tier 2 UI smoke tests.
 *
 * REMOTE WORKSPACE NOTE: The Playwright headless Chromium requires glibc >= 2.38
 * which is not available on the Snowflake remote development workspace (system
 * libc.so.6 is older). Tier 2 tests are intended to run in CI (GitHub Actions,
 * etc.) where a proper Ubuntu/Debian environment is available.
 *
 * For local development, use Tier 1 (validate-views.py) and Tier 1.5
 * (validate-views-api.py) which have no browser dependency.
 *
 * To run locally if your system has glibc >= 2.38:
 *   NODE=/path/to/node APP_URL=http://localhost:3000 <node> node_modules/@playwright/test/cli.js test
 */

const NODE = process.env.NODE_BIN ||
  '/home/vganesan/.snowflake-coco-server/server/node';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    headless: true,
  },
  // The app must be running before tests execute.
  // Start it separately: <NODE> node_modules/.bin/next dev
  // Then run: BASE_URL=http://localhost:3000 <NODE> node_modules/@playwright/test/cli.js test
});

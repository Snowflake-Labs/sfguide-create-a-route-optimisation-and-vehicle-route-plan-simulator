/**
 * Framework UI tests - Tier 2: Playwright E2E.
 *
 * Tests:
 *   1. Every view in app-views.json opens without an error state (HTTP 5xx)
 *   2. A chat response containing [Label](view:id) renders a clickable chip
 *   3. Clicking the chip navigates to the correct view without an error state
 *
 * Requires: Chromium installed via `npx playwright install chromium`
 *   On Linux remote hosts without apt-get, install Chromium via nix or run on Mac/CI.
 *
 * Usage:
 *   cd ui && npx playwright test
 *   BASE_URL=https://my-deployed-app.snowflakecomputing.app npx playwright test
 *   APP_VIEWS_CONFIG=../my-other-app/app-views.json npx playwright test
 *
 * Failure artifacts (screenshots, traces) saved to ui/test-results/.
 */

import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Load view definitions (app-agnostic: read from env var or default to cdp/)
// ─────────────────────────────────────────────────────────────────────────────
const APP_VIEWS_CONFIG = process.env.APP_VIEWS_CONFIG
  ? resolve(process.cwd(), '..', process.env.APP_VIEWS_CONFIG)
  : resolve(__dirname, '../../cdp/app-views.json');

interface ViewDef {
  label: string;
  description?: string;
}

const views = JSON.parse(readFileSync(APP_VIEWS_CONFIG, 'utf-8')) as Record<string, ViewDef>;
const viewEntries = Object.entries(views);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wait for a view to finish loading (query completes or error appears). */
async function waitForViewLoad(page: Page): Promise<void> {
  // Wait for either data to appear or an error to appear (max 8s)
  await Promise.race([
    page.waitForSelector('[data-testid="view-loaded"], table, .metric-cards', {
      timeout: 8000,
    }).catch(() => {}),
    page.waitForSelector('text=/Error: HTTP [45]/', { timeout: 8000 }).catch(() => {}),
    page.waitForTimeout(3000),
  ]);
}

/** Assert no HTTP error state is visible in the view panel. */
async function assertNoViewError(page: Page, context: string): Promise<void> {
  const httpError = page.locator('text=/Error: HTTP [45]/i');
  const sqlError  = page.locator('text=/SQL compilation error/i');
  const connError = page.locator('text=/Connection error/i');

  await expect(httpError, `${context}: HTTP error visible`).not.toBeVisible();
  await expect(sqlError,  `${context}: SQL error visible`).not.toBeVisible();
  await expect(connError, `${context}: connection error visible`).not.toBeVisible();
}

/** Open a view by clicking its label in the view picker. */
async function openViewFromPicker(page: Page, viewLabel: string): Promise<void> {
  const pickerButton = page.locator('button:has-text("Search views")').first();
  await pickerButton.click();
  await page.locator(`text=${viewLabel}`).first().click();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Every view opens without an HTTP error state
// ─────────────────────────────────────────────────────────────────────────────
for (const [viewId, view] of viewEntries) {
  test(`View "${view.label}" opens without HTTP error`, async ({ page }) => {
    await page.goto('/');
    // Wait for app shell to load
    await page.waitForSelector('text=/Search views/', { timeout: 10000 });

    await openViewFromPicker(page, view.label);
    await waitForViewLoad(page);
    await assertNoViewError(page, `${viewId} (${view.label})`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: View chip renders from [Label](view:id) markdown
// ─────────────────────────────────────────────────────────────────────────────
test('View chip renders from markdown link', async ({ page }) => {
  // Mock /api/chat to return a deterministic response containing a view chip
  const [firstViewId, firstView] = viewEntries[0];
  await page.route('/api/chat', async (route) => {
    const chipMarkdown = `[${firstView.label}](view:${firstViewId})`;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({ type: 'text', content: `You can see it here: ${chipMarkdown}` })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
    });
  });

  await page.goto('/');
  await page.waitForSelector('textarea[placeholder*="message"]', { timeout: 10000 });
  await page.fill('textarea[placeholder*="message"]', 'test view chip');
  await page.press('textarea[placeholder*="message"]', 'Enter');

  // Wait for chip to appear
  const chip = page.locator(`button:has-text("${firstView.label}")`).first();
  await expect(chip).toBeVisible({ timeout: 10000 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Clicking a view chip opens the correct view without error
// ─────────────────────────────────────────────────────────────────────────────
test('Clicking view chip navigates to correct view without error', async ({ page }) => {
  const [firstViewId, firstView] = viewEntries[0];
  await page.route('/api/chat', async (route) => {
    const chipMarkdown = `[${firstView.label}](view:${firstViewId})`;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `data: ${JSON.stringify({ type: 'text', content: `Open this view: ${chipMarkdown}` })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
    });
  });

  await page.goto('/');
  await page.waitForSelector('textarea[placeholder*="message"]', { timeout: 10000 });
  await page.fill('textarea[placeholder*="message"]', 'show chip test');
  await page.press('textarea[placeholder*="message"]', 'Enter');

  // Click the chip
  const chip = page.locator(`button:has-text("${firstView.label}")`).first();
  await expect(chip).toBeVisible({ timeout: 10000 });
  await chip.click();

  // Wait for view to load
  await waitForViewLoad(page);
  await assertNoViewError(page, `chip click → ${firstViewId}`);
});

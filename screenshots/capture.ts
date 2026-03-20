/**
 * Automated screenshot capture for Pinchy feature pages.
 *
 * Usage:
 *   npx playwright test screenshots/capture.ts
 *
 * Expects Pinchy running at BASE_URL (default: http://localhost:7777).
 * Run seed.ts first to populate demo data.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:7777";
const ADMIN_EMAIL = "admin@demo.pinchy.dev";
const ADMIN_PASSWORD = "PinchyDemo2026!";
const OUTPUT_DIR = process.env.SCREENSHOT_DIR ?? "screenshots/output";
const STORAGE_STATE = path.join(OUTPUT_DIR, ".auth.json");

// Standard viewport for website screenshots (clean 16:10 ratio)
const VIEWPORT = { width: 1440, height: 900 };

async function login(page: Page) {
  // Reuse existing session if available
  if (fs.existsSync(STORAGE_STATE)) {
    await page.goto(`${BASE_URL}/`);
    // Check if we're redirected to login
    await page.waitForTimeout(2000);
    if (!page.url().includes("/login")) return;
  }

  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Wait for redirect to app
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 30000,
  });
  // Save session for reuse
  await page.context().storageState({ path: STORAGE_STATE });
}

test.describe("Feature screenshots", () => {
  test.use({ viewport: VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("chat interface", async ({ page }) => {
    // Navigate to Smithers (default agent) chat
    await page.goto(`${BASE_URL}/`);
    // Wait for sidebar to load with agents
    await page.waitForSelector('[data-testid="agent-sidebar"]', { timeout: 10000 }).catch(() => {
      // Fallback: just wait for page to be interactive
    });
    // Click first agent in sidebar if available
    const firstAgent = page.locator('a[href^="/chat/"]').first();
    if (await firstAgent.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstAgent.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/chat-interface.png`,
      fullPage: false,
    });
  });

  test("agent list", async ({ page }) => {
    await page.goto(`${BASE_URL}/agents`);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${OUTPUT_DIR}/agent-list.png`,
      fullPage: false,
    });
  });

  test("agent settings - general", async ({ page }) => {
    // Navigate to first agent's settings
    await page.goto(`${BASE_URL}/agents`);
    await page.waitForTimeout(1000);
    const settingsLink = page.locator('a[href*="/agents/"]').first();
    if (await settingsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await settingsLink.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/agent-settings-general.png`,
      fullPage: false,
    });
  });

  test("agent settings - personality", async ({ page }) => {
    await page.goto(`${BASE_URL}/agents`);
    await page.waitForTimeout(1000);
    const settingsLink = page.locator('a[href*="/agents/"]').first();
    if (await settingsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await settingsLink.click();
      await page.waitForTimeout(500);
    }
    // Click personality tab
    const personalityTab = page.getByRole("tab", { name: /personality/i });
    if (await personalityTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await personalityTab.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/agent-settings-personality.png`,
      fullPage: false,
    });
  });

  test("agent settings - permissions", async ({ page }) => {
    await page.goto(`${BASE_URL}/agents`);
    await page.waitForTimeout(1000);
    const settingsLink = page.locator('a[href*="/agents/"]').first();
    if (await settingsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await settingsLink.click();
      await page.waitForTimeout(500);
    }
    const permissionsTab = page.getByRole("tab", { name: /permissions/i });
    if (await permissionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await permissionsTab.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/agent-settings-permissions.png`,
      fullPage: false,
    });
  });

  test("audit trail", async ({ page }) => {
    await page.goto(`${BASE_URL}/audit`);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${OUTPUT_DIR}/audit-trail.png`,
      fullPage: false,
    });
  });

  test("user management", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1000);
    // Click Users tab/link
    const usersLink = page.getByRole("link", { name: /users/i });
    if (await usersLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersLink.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/user-management.png`,
      fullPage: false,
    });
  });

  test("groups", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1000);
    const groupsLink = page.getByRole("link", { name: /groups/i });
    if (await groupsLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupsLink.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${OUTPUT_DIR}/groups.png`,
      fullPage: false,
    });
  });

  test("provider settings", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1000);
    // Providers are usually on the main settings page
    await page.screenshot({
      path: `${OUTPUT_DIR}/provider-settings.png`,
      fullPage: false,
    });
  });
});

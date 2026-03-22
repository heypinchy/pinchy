/**
 * Automated screenshot capture for Pinchy feature pages.
 *
 * Expects Pinchy running at BASE_URL (default: http://localhost:7777).
 * Run seed.sh first to populate demo data.
 */
import { test, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:7777";
const ADMIN_EMAIL = "monty@snpp.com";
const ADMIN_PASSWORD = "PinchyDemo2026!";
const OUTPUT_DIR = process.env.SCREENSHOT_DIR ?? "screenshots/output";
const STORAGE_STATE = path.join(OUTPUT_DIR, ".auth.json");

// Narrower viewport — fills the screen better
const VIEWPORT = { width: 1280, height: 720 };

async function login(page: Page) {
  if (fs.existsSync(STORAGE_STATE)) {
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(2000);
    if (!page.url().includes("/login") && !page.url().includes("/setup")) return;
  }

  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(1000);
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(
    (url) => !url.pathname.includes("/login") && !url.pathname.includes("/setup"),
    { timeout: 30000 },
  );
  await page.context().storageState({ path: STORAGE_STATE });
}

async function screenshot(page: Page, name: string) {
  const dir = path.dirname(path.join(OUTPUT_DIR, name));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${OUTPUT_DIR}/${name}`, fullPage: false });
}

// Get agent ID from API
async function getAgentId(page: Page, name: string): Promise<string | null> {
  const response = await page.request.get(`${BASE_URL}/api/agents`);
  const agents = await response.json();
  const agent = agents.find((a: { name: string }) => a.name === name);
  return agent?.id || null;
}

test.describe("Feature screenshots", () => {
  test.use({ viewport: VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("01 audit trail", async ({ page }) => {
    await page.goto(`${BASE_URL}/audit`);
    await page.waitForTimeout(2000);
    await screenshot(page, "audit-trail.png");
  });

  test("02 chat interface", async ({ page }) => {
    const smithersId = await getAgentId(page, "Smithers");
    if (smithersId) {
      await page.goto(`${BASE_URL}/chat/${smithersId}`);
    }
    await page.waitForTimeout(2000);

    // Type something in the input field to make it look dynamic
    const input = page.locator('textarea, input[placeholder*="message" i], [contenteditable]').first();
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await input.fill("It's Burns. Industrialist, bon vivant, amateur lepidopterist. Keep answers brief and never mention the word 'union.' Excellent.");
    }

    await screenshot(page, "chat-interface.png");
  });

  test("agent settings - general", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(2000);
    }
    await screenshot(page, "agent-settings-general.png");
  });

  test("agent settings - personality", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(1500);
      const tab = page.getByRole("tab", { name: /personality/i });
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1500);
      }
    }
    await screenshot(page, "agent-settings-personality.png");
  });

  test("agent settings - permissions", async ({ page }) => {
    // Use Atlas — has safe tools + directories configured
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(1500);
      const tab = page.getByRole("tab", { name: /permissions/i });
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1500);
      }
    }
    await screenshot(page, "agent-settings-permissions.png");
  });

  test("agent settings - access", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(1500);
      const tab = page.getByRole("tab", { name: /access/i });
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1500);
      }
    }
    await screenshot(page, "agent-settings-access.png");
  });

  // audit trail is test 01 (first) to avoid Playwright login noise

  test("user management", async ({ page }) => {
    // Use wider viewport for user management to fit the Revoke button
    await page.setViewportSize({ width: 1440, height: 720 });
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const usersTab = page.getByRole("tab", { name: /users/i });
    if (await usersTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTab.click();
    } else {
      await page.locator("text=Users").first().click().catch(() => {});
    }
    await page.waitForTimeout(1500);
    // Inject CSS to fix overflow clipping on the Revoke button
    await page.addStyleTag({
      content: `
        * { overflow: visible !important; overflow-x: visible !important; }
        table { table-layout: auto !important; width: auto !important; }
      `,
    });
    await page.waitForTimeout(300);
    await screenshot(page, "user-management.png");
  });

  test("groups", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const groupsTab = page.getByRole("tab", { name: /groups/i });
    if (await groupsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupsTab.click();
    } else {
      await page.locator("text=Groups").first().click().catch(() => {});
    }
    await page.waitForTimeout(1500);
    await screenshot(page, "groups.png");
  });

  test("provider settings", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const providerTab = page.getByRole("tab", { name: /provider/i });
    if (await providerTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await providerTab.click();
      await page.waitForTimeout(1000);
    }
    // Click on the Anthropic provider card to expand it
    const anthropicCard = page.locator("text=Anthropic").first();
    if (await anthropicCard.isVisible({ timeout: 2000 }).catch(() => false)) {
      await anthropicCard.click();
      await page.waitForTimeout(1000);
    }
    await screenshot(page, "provider-settings.png");
  });
});

/**
 * Automated screenshot capture for Pinchy feature pages.
 *
 * Expects Pinchy running at BASE_URL (default: http://localhost:7777).
 * Run seed.sh first to populate demo data.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
// Imported, not copy-pasted: the question below is typed into the composer and
// has to be byte-identical to the string the fake model matches on, or the
// agent answers something generic and the shot is worthless. Importing the
// module is side-effect free — it only defines; `startFakeOllama()` is what
// binds a port.
import { FAKE_OLLAMA_KB_SCREENSHOT_TRIGGER } from "../packages/web/e2e/shared/fake-ollama/fake-ollama-server";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:7777";
const ADMIN_EMAIL = "monty@snpp.com";
const ADMIN_PASSWORD = "PinchyDemo2026!";
const OUTPUT_DIR = process.env.SCREENSHOT_DIR ?? "screenshots/output";
const STORAGE_STATE = path.join(OUTPUT_DIR, ".auth.json");

// Narrower viewport — fills the screen better
const VIEWPORT = { width: 1280, height: 720 };

async function login(page: Page) {
  // Try restoring session from saved state
  if (fs.existsSync(STORAGE_STATE)) {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE, "utf-8"));
    await page.context().addCookies(state.cookies || []);
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(2000);
    if (!page.url().includes("/login") && !page.url().includes("/setup"))
      return;
  }

  // Session invalid or not saved — perform fresh login
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel(/email/i).waitFor({ state: "visible", timeout: 30000 });
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(
    (url) =>
      !url.pathname.includes("/login") && !url.pathname.includes("/setup"),
    { timeout: 30000 },
  );
  await page.context().storageState({ path: STORAGE_STATE });
}

/**
 * Capture a screenshot to OUTPUT_DIR/<name>.
 *
 * Without `target`, captures the full 1280x720 window (the docs consumer wants
 * this — readers see where a feature lives in the app). With a `target`
 * selector, captures just that element: a focused, legible panel for the
 * marketing site, which shrinks images hard (especially on 375px mobile). Both
 * variants are produced additively from the same loaded page — never replace
 * the full shots, other consumers depend on them.
 *
 * `target` also accepts an already-resolved Locator, for a subject that no
 * CSS selector pins down on its own (a `<section>` identified by its heading).
 */
async function screenshot(page: Page, name: string, target?: string | Locator) {
  const dir = path.dirname(path.join(OUTPUT_DIR, name));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Hide the warning/promo banners so marketing screenshots show the app the
  // way a domain-locked, licensed production instance does: the amber
  // "instance is not secured" warning and the "Buy Pinchy Pro" trial banner.
  // We hide rather than configure these away: locking a real domain would
  // silence the warning but also turns on the host-check (403 for localhost)
  // and Secure cookies (rejected over HTTP), breaking the capture run; the
  // trial banner is inherent to the trial license CI mints for screenshots.
  // Injected here, after the page has loaded (head exists) — an addInitScript
  // runs before document.documentElement exists and silently throws, leaving
  // the banners visible. There is no CSP to block the injected <style>.
  //
  // Matched by testid *suffix* rather than by the two names, so a banner added
  // later is hidden by convention instead of quietly shipping in every
  // marketing shot. Nothing else in the app carries a `*banner` testid.
  await page.addStyleTag({
    content: '[data-testid$="banner"]{display:none !important}',
  });
  // Then check it took. This one rule is all that stands between a marketing
  // screenshot and an orange security warning across the top, and until now
  // nothing verified it — rename a testid and every published shot silently
  // regains the stripe. A security warning in an advertising screenshot is
  // worse than no screenshot, so this fails the capture instead.
  const banners = page.locator('[data-testid$="banner"]');
  for (let i = 0; i < (await banners.count()); i++) {
    await expect(
      banners.nth(i),
      `a banner is visible in ${name} — check the testid convention`,
    ).toBeHidden();
  }
  const out = `${OUTPUT_DIR}/${name}`;
  if (target) {
    // .first() guards against nested matches; animations:"disabled" freezes
    // CSS/Web animations so the element's box settles (element screenshots
    // wait for a stable bounding box, unlike page.screenshot).
    const locator = typeof target === "string" ? page.locator(target) : target;
    await locator.first().screenshot({ path: out, animations: "disabled" });
  } else {
    await page.screenshot({ path: out, fullPage: false });
  }
}

// Get agent ID from API
async function getAgentId(page: Page, name: string): Promise<string | null> {
  const response = await page.request.get(`${BASE_URL}/api/agents`);
  const agents = await response.json();
  const agent = agents.find((a: { name: string }) => a.name === name);
  return agent?.id || null;
}

test.describe("Feature screenshots", () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("01 audit trail", async ({ page }) => {
    await page.goto(`${BASE_URL}/audit`);
    await page.waitForTimeout(2000);
    await screenshot(page, "audit-trail.png");
    // Focused: the content region (<main>) drops the sidebar + banners.
    await screenshot(page, "focus/audit-trail.png", "main");
  });

  test("02 chat interface", async ({ page }) => {
    const smithersId = await getAgentId(page, "Smithers");
    if (smithersId) {
      await page.goto(`${BASE_URL}/chat/${smithersId}`);
    }

    // Wait for the chat to actually be ready before screenshotting — otherwise
    // we capture either the "Reconnecting to the agent..." overlay or the
    // initial yellow "Starting..." dot. The connection indicator's aria-label
    // flips to "Connected" once useChatStatus reaches `ready`, and every
    // agent's greetingMessage renders a `[data-role="assistant"]` bubble
    // immediately after that.
    //
    // 90s timeout: OpenClaw cold-start in CI compounds plugin warmup, schema
    // introspection, and config-change restarts (see #302). 30s wasn't
    // enough on the v0.5.2 release — failed twice with the indicator never
    // flipping to "Connected" within budget.
    await page
      .getByRole("button", { name: "Connected" })
      .waitFor({ timeout: 90000 });
    await page
      .locator('[data-role="assistant"]')
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});

    // Type something in the input field to make it look dynamic
    const input = page
      .locator('textarea, input[placeholder*="message" i], [contenteditable]')
      .first();
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await input.fill(
        "It's Burns. Industrialist, bon vivant, amateur lepidopterist. Keep answers brief and never mention the word 'union.' Excellent.",
      );
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
    // Focused: the content region (<main>) drops the sidebar + banners.
    await screenshot(page, "focus/agent-settings-permissions.png", "main");
  });

  test("agent settings - web search", async ({ page }) => {
    // Taller viewport so chips + advanced options fit in one screenshot
    await page.setViewportSize({ width: 1280, height: 960 });
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(1500);
      const tab = page.getByRole("tab", { name: /permissions/i });
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1500);
      }
      // Expand the Advanced options inside the Web Search section
      const advancedTrigger = page.getByRole("button", {
        name: /advanced options/i,
      });
      if (
        await advancedTrigger.isVisible({ timeout: 2000 }).catch(() => false)
      ) {
        await advancedTrigger.click();
        await page.waitForTimeout(800);
      }
      // Bring the Web Search section into view
      const webHeading = page
        .getByRole("heading", { name: /web search/i })
        .first();
      if (await webHeading.isVisible({ timeout: 2000 }).catch(() => false)) {
        await webHeading.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
      }
    }
    await screenshot(page, "agent-settings-web-search.png");
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
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const usersTab = page.getByRole("tab", { name: /users/i });
    if (await usersTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTab.click();
    } else {
      await page
        .locator("text=Users")
        .first()
        .click()
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    await screenshot(page, "user-management.png");
    // Focused: the content region (<main>) drops the sidebar + banners.
    await screenshot(page, "focus/user-management.png", "main");
  });

  test("groups", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const groupsTab = page.getByRole("tab", { name: /groups/i });
    if (await groupsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupsTab.click();
    } else {
      await page
        .locator("text=Groups")
        .first()
        .click()
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    await screenshot(page, "groups.png");
    // Focused: the content region (<main>) drops the sidebar + banners.
    await screenshot(page, "focus/groups.png", "main");
  });

  test("usage dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/usage`);
    await page.waitForTimeout(2500);
    await screenshot(page, "usage-dashboard.png");
    // Focused: the content region (<main>) drops the sidebar + banners.
    await screenshot(page, "focus/usage-dashboard.png", "main");
  });

  test("agent settings - telegram", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    if (agentId) {
      await page.goto(`${BASE_URL}/chat/${agentId}/settings`);
      await page.waitForTimeout(1500);
      const tab = page.getByRole("tab", { name: /telegram/i });
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1500);
      }
    }
    await screenshot(page, "agent-settings-telegram.png");
  });

  test("settings telegram", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const telegramTab = page.getByRole("tab", { name: /telegram/i });
    if (await telegramTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await telegramTab.click();
    } else {
      await page
        .locator("text=Telegram")
        .first()
        .click()
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    await screenshot(page, "settings-telegram.png");
  });

  test("integrations odoo wizard", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const integrationsTab = page.getByRole("tab", { name: /integrations/i });
    if (await integrationsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await integrationsTab.click();
    } else {
      await page
        .locator("text=Integrations")
        .first()
        .click()
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    const addButton = page.getByRole("button", { name: /add integration/i });
    if (await addButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addButton.click();
      await page.waitForTimeout(800);
      const odooOption = page.getByRole("button", { name: /odoo/i }).first();
      if (await odooOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await odooOption.click();
        await page.waitForTimeout(1000);
      }
    }
    await screenshot(page, "integrations-odoo-wizard.png");
  });

  test("integrations google wizard", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForTimeout(1500);
    const integrationsTab = page.getByRole("tab", { name: /integrations/i });
    if (await integrationsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await integrationsTab.click();
    } else {
      await page
        .locator("text=Integrations")
        .first()
        .click()
        .catch(() => {});
    }
    await page.waitForTimeout(1500);
    const addButton = page.getByRole("button", { name: /add integration/i });
    if (await addButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addButton.click();
      await page.waitForTimeout(800);
      const googleOption = page
        .getByRole("button", { name: /google/i })
        .first();
      if (await googleOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await googleOption.click();
        await page.waitForTimeout(1000);
      }
    }
    await screenshot(page, "integrations-google-wizard.png");
  });

  // The three cases below are deliberately strict where the ones above are
  // forgiving. Every older case wraps its navigation in `.catch(() => false)`
  // and screenshots whatever is on screen either way, so a moved control
  // yields a plausible-looking picture of the wrong thing and the run stays
  // green — which is how `provider-settings.png` sat on heypinchy.com for two
  // releases showing a settings tab bar that no longer exists. These assert
  // that the subject is actually visible before the shutter fires, so drift
  // fails the capture job instead of publishing a lie. They also navigate by
  // `?tab=` rather than clicking, which survives the sidebar/tab-bar rework.
  test("provider settings grid", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings?tab=provider`);
    await expect(
      page.getByRole("heading", { name: "AI Provider" }),
    ).toBeVisible({
      timeout: 15000,
    });
    // The tile grid, not the old five-button row: assert a real tile and the
    // default-marker the 0.9.0 redesign introduced.
    await expect(
      page.getByRole("button", { name: /anthropic/i }).first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="tile-default"]').first(),
    ).toBeVisible();
    await screenshot(page, "provider-settings.png");
    await screenshot(page, "focus/provider-settings.png", "main");
  });

  test("integrations imap wizard", async ({ page }) => {
    await page.goto(`${BASE_URL}/settings?tab=integrations`);
    const addButton = page.getByRole("button", { name: /add integration/i });
    await expect(addButton).toBeVisible({ timeout: 15000 });
    await addButton.click();
    await page.getByRole("button", { name: /imap \/ other email/i }).click();
    // The connect step, not the picker it was launched from.
    await expect(
      page.getByRole("heading", { name: /connect imap/i }),
    ).toBeVisible({
      timeout: 10000,
    });
    await screenshot(page, "integrations-imap-wizard.png");
  });

  test("agent settings - knowledge base", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    expect(agentId, "seed.sh must create the Frink agent").toBeTruthy();
    await page.goto(`${BASE_URL}/chat/${agentId}/settings?tab=permissions`);
    const kb = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Knowledge Base" }) })
      .first();
    await expect(kb).toBeVisible({ timeout: 15000 });
    // Frink is seeded with 3 of 6 directories granted — the scoping this
    // section exists to show. An empty picker means the seed regressed.
    await expect(kb.getByText("/data/Reactor Operations")).toBeVisible();
    await screenshot(page, "focus/agent-settings-knowledge-base.png", kb);
  });

  // The Knowledge Base answer — 0.9.0's headline feature, and the one shot
  // that shows what it actually does: an answer synthesised from two documents
  // with inline citations and a resolvable Sources list.
  //
  // Needs docker-compose.screenshots.yml (a model that answers) plus the
  // fixtures and index seed.sh builds under it. Detected by Frink's model
  // rather than an env var, so a plain `docker compose up` + seed still
  // produces the other sixteen shots instead of failing the whole run.
  test("knowledge base answer with citations", async ({ page }) => {
    const agentId = await getAgentId(page, "Frink");
    expect(agentId, "seed.sh must create the Frink agent").toBeTruthy();

    const agent = await (
      await page.request.get(`${BASE_URL}/api/agents/${agentId}`)
    ).json();
    test.skip(
      !String(agent?.model ?? "").startsWith("ollama/"),
      "no deterministic model — run with docker-compose.screenshots.yml",
    );

    await page.goto(`${BASE_URL}/chat/${agentId}`);
    await page
      .getByRole("button", { name: "Connected" })
      .waitFor({ timeout: 90000 });

    const composer = page
      .locator('textarea, input[placeholder*="message" i], [contenteditable]')
      .first();
    await composer.fill(FAKE_OLLAMA_KB_SCREENSHOT_TRIGGER);
    await composer.press("Enter");

    // Wait for the Sources list, not merely for an assistant bubble: the
    // bubble appears the moment the first token streams, and a shot taken
    // then shows half a sentence. The list is the last thing written.
    const answer = page.locator('[data-role="assistant"]').last();
    await expect(answer).toContainText("Sources", { timeout: 120000 });
    // Both citations resolved, so the picture is of a working feature rather
    // than a model that cited one document and invented the other.
    await expect(answer).toContainText("emergency-shutdown-procedure.pdf");
    await expect(answer).toContainText("coolant-system-overview.pdf");

    await screenshot(page, "knowledge-base-answer.png");
    await screenshot(page, "focus/knowledge-base-answer.png", "main");
  });
});

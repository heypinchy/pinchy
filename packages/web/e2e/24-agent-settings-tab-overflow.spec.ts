// packages/web/e2e/24-agent-settings-tab-overflow.spec.ts
//
// Real-browser regression guard for #1400: the agent settings tab bar
// (General … Diagnostics, ~700px) is wider than a phone screen and wider than
// the settings column in a narrow desktop window. It used to overflow its
// parent, so the whole settings column scrolled sideways and the later tabs
// were only reachable that way. The fix makes the tab list scroll on its own.
//
// jsdom cannot replace this spec: the bug IS layout, and jsdom reports every
// width as 0. The unit test in agent-settings-page-content-tab-overflow.test.tsx
// can only assert the classes are present; only a real browser measures
// whether the page still scrolls sideways.
import { test, expect, type Page } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

const AGENT_NAME = "Tab Overflow Agent";

// A shared agent seen by an admin shows all eight tabs (Permissions, Access,
// Automations only exist there) — the ~700px bar measured on staging. The
// personal Smithers shows five, which fits a desktop column and would let the
// narrow-desktop case pass without exercising it.
async function sharedAgentId(page: Page): Promise<string> {
  const agents = (await (await page.request.get("/api/agents")).json()) as {
    id: string;
    name: string;
  }[];
  const existing = agents.find((a) => a.name === AGENT_NAME);
  if (existing) return existing.id;
  const res = await page.request.post("/api/agents", {
    data: { name: AGENT_NAME, templateId: "custom", tagline: "Tab overflow check" },
  });
  const body = await res.json();
  if (!res.ok()) throw new Error(`Failed to create agent: ${JSON.stringify(body)}`);
  return body.id;
}

async function openAgentSettings(page: Page, query = "") {
  await page.goto(`/chat/${await sharedAgentId(page)}/settings${query}`);
  const tablist = page.getByRole("tablist");
  await expect(tablist).toBeVisible({ timeout: 15000 });
  // The settings column is the nearest vertically-scrolling ancestor.
  const column = tablist.locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
  return { tablist, column };
}

async function widths(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
}

test.describe("agent settings tab bar overflow (#1400)", () => {
  test.beforeEach(async ({ page, request }) => {
    const setupResponse = await request.post("/api/setup", {
      data: { name: "Test Admin", email: "admin@test.local", password: "test-password-123" },
    });
    expect([201, 403]).toContain(setupResponse.status());
    await seedProviderConfig();

    // Sign in over the auth API — the login form races hydration on a cold
    // server's first compile (see 19-message-hover-layout-shift.spec.ts).
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: "admin@test.local", password: "test-password-123" },
      headers: { "Content-Type": "application/json" },
    });
    expect(signIn.ok()).toBeTruthy();
  });

  for (const viewport of [
    { name: "phone", width: 375, height: 812 },
    { name: "narrow desktop", width: 1040, height: 800 },
  ]) {
    test(`the settings column never scrolls sideways (${viewport.name}, ${viewport.width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { tablist, column } = await openAgentSettings(page);

      const col = await widths(column);
      expect(
        col.scroll,
        `settings column scrolls sideways: scrollWidth ${col.scroll}px > clientWidth ${col.client}px`
      ).toBeLessThanOrEqual(col.client);

      const list = await widths(tablist);
      expect(list.client).toBeLessThanOrEqual(col.client);
      await expect(page.getByRole("tab")).toHaveCount(8);

      // The scrollbar is hidden, so the edge with more tabs beyond it fades
      // out — otherwise nothing hints that Diagnostics exists.
      await expect
        .poll(() => tablist.evaluate((el) => (el as HTMLElement).style.maskImage))
        .toContain("transparent");
    });
  }

  test("on a phone the tab list scrolls itself and keeps a deep-linked tab in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { tablist } = await openAgentSettings(page, "?tab=diagnostics");

    // Proves the tabs really are wider than the screen here — otherwise the
    // checks below would pass without exercising the overflow at all.
    const list = await widths(tablist);
    expect(list.scroll).toBeGreaterThan(list.client);

    const diagnostics = page.getByRole("tab", { name: "Diagnostics" });
    await expect(diagnostics).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () => {
        const listBox = (await tablist.boundingBox())!;
        const tabBox = (await diagnostics.boundingBox())!;
        return (
          tabBox.x + tabBox.width <= listBox.x + listBox.width + 1 && tabBox.x >= listBox.x - 1
        );
      })
      .toBe(true);
  });
});

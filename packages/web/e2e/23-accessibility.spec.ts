import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
  type Locator,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  ADMIN_USER,
  SECOND_USER,
  apiSignIn,
  createSecondUserViaInvite,
  loginAsAdmin,
  seedProviderConfig,
} from "./helpers";

/**
 * Accessibility and small-screen regression guard (#1300).
 *
 * An axe sweep of staging before v0.10.0 found contrast, naming and
 * nested-control violations on every signed-in page — none of which any test
 * could see, because jsdom has no layout and no computed colours. This spec
 * runs axe against the real rendered pages and fails on any `serious` or
 * `critical` WCAG 2.1 A/AA violation, in the light theme at desktop and phone
 * width and in the dark theme at desktop width.
 *
 * `moderate`/`minor` findings are deliberately not gated: they are mostly
 * best-practice advice, and a guard that goes red on advice gets switched off.
 *
 * Each page waits for content it only renders once its data is in, so axe
 * scans the finished page, not a loading skeleton that would pass vacuously.
 * Where that content is a control, it is found by its accessible name (the
 * "Model" combobox, the context textboxes) — so a control that loses its name
 * fails here, naming the locator, before axe runs.
 */

const TEST_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test";
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const MEMBER_EMAIL = "a11y-member@test.local";

type Mode = { name: string; width: number; colorScheme: "light" | "dark" };
const MODES: Mode[] = [
  { name: "light, desktop", width: 1280, colorScheme: "light" },
  { name: "light, phone", width: 375, colorScheme: "light" },
  { name: "dark, desktop", width: 1280, colorScheme: "dark" },
];

type Ready = (page: Page) => Locator;
/** Where a session's pages live: its own chat, and a shared agent's settings. */
type Paths = { chat: string; sharedAgent: string };
type Target = { name: string; path: (paths: Paths) => string; ready: Ready };

/**
 * This stack runs no OpenClaw, so the thread settles on "Reconnecting to the
 * agent..." about 2s after the composer appears (the disconnect hysteresis).
 * Waiting for that end state scans the same page every run, instead of
 * whichever of "Starting agent..." and "Reconnecting..." axe happens to catch.
 */
const chatReady: Ready = (page) => page.getByText("Reconnecting to the agent...");

const ADMIN_PAGES: Target[] = [
  {
    name: "chat",
    path: ({ chat }) => chat,
    ready: chatReady,
  },
  {
    // A shared agent: personal agents have no Permissions or Access tab.
    name: "agent settings › general",
    path: ({ sharedAgent }) => `${sharedAgent}/settings?tab=general`,
    ready: (page) => page.getByRole("combobox", { name: "Model" }),
  },
  {
    name: "agent settings › permissions",
    path: ({ sharedAgent }) => `${sharedAgent}/settings?tab=permissions`,
    ready: (page) => page.getByRole("heading", { name: "Memory" }),
  },
  {
    name: "settings › context",
    path: () => "/settings?tab=context",
    ready: (page) => page.getByRole("textbox", { name: "Organization Context" }),
  },
  {
    name: "settings › security",
    path: () => "/settings?tab=security",
    // A control that only the loaded state renders: the card title alone
    // also shows on the "Failed to load" branch.
    ready: (page) => page.getByRole("button", { name: "Lock this domain" }),
  },
  {
    name: "audit trail",
    path: () => "/audit",
    // The login that opened this session wrote an `auth.login` row, so the
    // list has at least one entry — the card/row markup is what axe checks.
    // Cards (phone) and table (desktop) both render; only one is visible.
    ready: (page) => page.getByText("auth.login").locator("visible=true").first(),
  },
  {
    name: "usage",
    path: () => "/usage",
    ready: (page) => page.getByRole("cell", { name: "Smithers" }).first(),
  },
  {
    name: "new agent",
    path: () => "/agents/new",
    ready: (page) => page.getByRole("button", { name: /start from scratch/i }),
  },
];

const MEMBER_PAGES: Target[] = [
  {
    name: "chat",
    path: ({ chat }) => chat,
    ready: chatReady,
  },
  {
    name: "settings › context",
    path: () => "/settings?tab=context",
    ready: (page) => page.getByRole("textbox", { name: "Your Context" }),
  },
];

/**
 * Wait until every finite animation and transition has settled. Content that
 * fades in (`animate-in fade-in`) is half-transparent for its first 300ms, and
 * axe measures the blended colour — a contrast failure that exists for a few
 * frames, not on the page. Infinite animations (spinners) never settle and are
 * not text, so they are left out.
 */
async function animationsSettled(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState === "finished" || a.playState === "idle")
  );
}

async function blockingViolations(page: Page) {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  return results.violations
    .filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""))
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary ?? ""}`),
    }));
}

const SHARED_AGENT_NAME = "A11y Shared Agent";

/**
 * Seed what the pages need to render more than an empty state, idempotently:
 * after a failing test Playwright restarts the worker and `beforeAll` runs
 * again, and every other page must still get its scan.
 *
 * - Usage rows, so /usage renders its chart and per-agent table (both carried
 *   findings, #1300). ~50k tokens puts a "50.0k"-wide label on the y-axis,
 *   the width that used to be clipped.
 * - A shared agent: personal agents have no Permissions or Access tab.
 * - A member, for the pages a member sees differently.
 */
async function seed(request: APIRequestContext, landingAgentId: string): Promise<string> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(TEST_DB_URL);
  try {
    const [admin] = await sql`SELECT id FROM "user" WHERE email = ${ADMIN_USER.email}`;
    const sessionKey = `agent:${landingAgentId}:direct:${admin.id}`;
    await sql`DELETE FROM usage_records WHERE session_key = ${sessionKey}`;
    for (const daysAgo of [2, 1]) {
      await sql`
        INSERT INTO usage_records
          (timestamp, user_id, agent_id, agent_name, session_key, model,
           input_tokens, output_tokens, estimated_cost_usd)
        VALUES
          (now() - make_interval(days => ${daysAgo}), ${admin.id}, ${landingAgentId}, 'Smithers',
           ${sessionKey}, 'anthropic/claude-haiku-4-5', ${40_000 + daysAgo * 5_000}, 5000, 0.12)
      `;
    }

    const [member] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER_EMAIL}`;
    if (!member) await createSecondUserViaInvite(request, { email: MEMBER_EMAIL });

    const [existing] = await sql`
      SELECT id FROM agents WHERE name = ${SHARED_AGENT_NAME} AND deleted_at IS NULL`;
    if (existing) return existing.id;
  } finally {
    await sql.end();
  }

  const res = await request.post("/api/agents", {
    data: { name: SHARED_AGENT_NAME, templateId: "custom", tagline: "Accessibility sweep" },
  });
  const body = await res.json();
  if (!res.ok()) throw new Error(`Failed to create agent: ${JSON.stringify(body)}`);
  return body.id;
}

async function openSession(browser: Browser, role: "admin" | "member") {
  // A page from browser.newPage() owns a hidden context that axe's
  // cross-frame runner refuses to use; it needs an explicit one.
  const context = await browser.newContext();
  const page = await context.newPage();
  if (role === "admin") {
    await loginAsAdmin(page);
  } else {
    await apiSignIn(page.request, MEMBER_EMAIL, SECOND_USER.password);
    await page.goto("/");
    await expect(page).toHaveURL(/\/chat\/[^/]+$/, { timeout: 30_000 });
  }
  return page;
}

async function show(page: Page, mode: Mode, url: string, ready: Ready) {
  await page.setViewportSize({ width: mode.width, height: 812 });
  await page.emulateMedia({ colorScheme: mode.colorScheme });
  await page.goto(url);
  // Generous: the dev server JIT-compiles each route on its first visit. The
  // describe's 90s test timeout leaves room for navigation and axe on top.
  await expect(ready(page)).toBeVisible({ timeout: 60_000 });
}

test.describe("Accessibility (axe, WCAG 2.1 AA)", () => {
  // The suite's default is 30s per test, and several of these routes are
  // first compiled by the dev server here (no earlier spec visits /usage).
  // The ready wait in `show()` gets 60s of that; navigation and axe the rest.
  test.describe.configure({ timeout: 90_000 });

  let admin: Page;
  let member: Page;
  let adminPaths: Paths;
  let memberPaths: Paths;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await seedProviderConfig();
    admin = await openSession(browser, "admin");
    const chat = new URL(admin.url()).pathname;
    const sharedAgentId = await seed(admin.request, chat.split("/").pop()!);
    adminPaths = { chat, sharedAgent: `/chat/${sharedAgentId}` };
    member = await openSession(browser, "member");
    memberPaths = { chat: new URL(member.url()).pathname, sharedAgent: adminPaths.sharedAgent };
  });

  test.afterAll(async () => {
    await admin?.context().close();
    await member?.context().close();
  });

  for (const mode of MODES) {
    for (const target of ADMIN_PAGES) {
      test(`admin › ${target.name} (${mode.name})`, async () => {
        await show(admin, mode, target.path(adminPaths), target.ready);
        expect(await blockingViolations(admin)).toEqual([]);
      });
    }
    for (const target of MEMBER_PAGES) {
      test(`member › ${target.name} (${mode.name})`, async () => {
        await show(member, mode, target.path(memberPaths), target.ready);
        expect(await blockingViolations(member)).toEqual([]);
      });
    }
  }

  // ── Small-screen layout ────────────────────────────────────────────────
  // axe does not see clipping; these measure it directly at 375px.
  const PHONE: Mode = MODES[1];

  test("audit trail filters stay inside a 375px screen", async () => {
    const page = admin;
    await show(page, PHONE, "/audit", (p) =>
      p.getByText("auth.login").locator("visible=true").first()
    );
    const viewport = page.viewportSize()!.width;
    const filters = [
      page.getByRole("combobox", { name: "Event Type" }),
      page.getByRole("combobox", { name: "Status" }),
      page.getByLabel("From", { exact: true }),
      page.getByLabel("To", { exact: true }),
    ];
    for (const filter of filters) {
      const box = await filter.boundingBox();
      expect(box, `${filter} is rendered`).not.toBeNull();
      expect(box!.x, `${filter} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${filter} ends on screen`).toBeLessThanOrEqual(viewport);
    }
  });

  test("usage chart's y-axis labels are not clipped at 375px", async () => {
    const page = admin;
    await show(page, PHONE, "/usage", (p) => p.getByRole("cell", { name: "Smithers" }).first());
    const chart = page.locator(".recharts-surface").first();
    await expect(chart).toBeVisible();
    const chartBox = (await chart.boundingBox())!;
    // The left y-axis end-anchors its labels at the axis line; the x-axis
    // centres its own. recharts 3 renders tick labels in a layer of their
    // own, outside the `.recharts-yAxis` group, so the anchor is the hook.
    const ticks = page.locator('.recharts-cartesian-axis-tick-value[text-anchor="end"]');
    await expect(ticks.first()).toBeVisible();
    for (const tick of await ticks.all()) {
      const box = (await tick.boundingBox())!;
      expect(
        box.x,
        `y-axis label "${await tick.textContent()}" starts inside the chart`
      ).toBeGreaterThanOrEqual(chartBox.x);
    }
  });
});

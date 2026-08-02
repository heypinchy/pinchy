import { test, expect, type Page } from "@playwright/test";
import { resetStack, waitForOpenClawSettledViaPage } from "./helpers";
import { pollAuditForEvent } from "../shared/dispatch-probe";

// E2E for the generic "OpenAI-compatible" provider type (#894), Task 13b.
//
// Runs against the setup-wizard Docker stack — the only overlay that wires the
// `llm-providers-mock` (docker-compose.setup-wizard-test.yml). The mock serves
// a dedicated OpenAI-compatible mount at
//   http://llm-providers-mock:9100/openai-compatible/v1
// exposing `GET /models` (discovery, Bearer) + `POST /chat/completions`
// (runtime, Bearer). No new stack or Playwright project — the base URL is
// reachable from both the Pinchy container (discovery) and the OpenClaw
// container (runtime chat) on the shared compose network, exactly like the
// built-in provider overrides.
//
// Two entry points are covered, sharing one `resetStack` (a container restart)
// via `test.describe.serial` so the second test can reuse the admin account and
// the provider the first one created:
//
//   Test 1 — the WIZARD custom-provider path (the nice-to-have from the prior
//     review). Selecting "Custom provider" in the wizard renders the same
//     `OpenAiCompatibleProviderForm` and POSTs the same
//     `/api/settings/providers/openai-compatible` route as Settings, so it
//     exercises the shared component + route + audit. Saving it as the sole
//     provider makes its slug the `default_provider`, so the auto-provisioned
//     Smithers agent resolves `<slug>/mock-large` (resolveCustomProvider →
//     models[0].id) and the first chat round-trips through the mock's
//     `/chat/completions`. This is the full deliverable: onboarding → a
//     `<slug>/<modelId>` agent → a successful chat.
//
//   Test 2 — the SETTINGS UI path (the task's primary phrasing). Logs back in,
//     opens Settings → AI Provider, and adds a SECOND OpenAI-compatible
//     provider as a tile in the unified provider grid (#894 settings
//     redesign — built-ins + custom providers + "Add custom provider" all in
//     one grid, no separate `OpenAiCompatibleProvidersSection` card),
//     asserting its own `config.changed` audit row. It then selects the new
//     tile and uses the explicit "Set as default" action, asserting the
//     `default_provider` switch. No second chat — Test 1 already proves the
//     runtime round-trip; this isolates the settings-surface add + set-default.
//
// Both tests assert the `config.changed` audit carries
// `authType: "openai-compatible"` + a host-only `baseUrlHost` and NEVER the API
// key or the full base URL (route contract in
// app/api/settings/providers/openai-compatible/route.ts).

const ADMIN = {
  name: "OAI-Compat Admin",
  email: "oai-compat@test.local",
  password: "oai-compat-password-123",
} as const;

// Reachable from the Pinchy + OpenClaw containers on the compose network. The
// openai-compatible discover route applies NO local-host/SSRF restriction (that
// guard is ollama-local only), and OpenClaw already fetches this bare internal
// host for the built-in `openai` override, so no `*.local` alias is needed.
const MOCK_BASE_URL = "http://llm-providers-mock:9100/openai-compatible/v1";
const MOCK_HOST = "llm-providers-mock:9100";

// Distinctive so the "no key in audit detail" assertion is meaningful — a
// substring search for this value across the serialized detail must find
// nothing.
const WIZARD_KEY = "sk-oai-compat-wizard-secret-abcdef";
const SETTINGS_KEY = "sk-oai-compat-settings-secret-uvwxyz";

const WIZARD_PROVIDER_NAME = "Mock Sovereign LLM";
const SETTINGS_PROVIDER_NAME = "Mock Gateway Two";

/** Read the config.changed detail as the route's known shape. */
interface ConfigChangedDetail {
  authType?: string;
  baseUrlHost?: string;
  modelCount?: number;
  configRegenerated?: boolean;
  provider?: { id?: string; name?: string };
  previousDefault?: string | null;
  newDefault?: string;
}

/**
 * Assert the freshest `config.changed` audit row for `providerName` records an
 * openai-compatible save with a host-only base URL and NO leaked secret.
 */
async function assertProviderConfigAudit(
  page: Page,
  opts: { since: string; providerName: string; apiKey: string }
): Promise<void> {
  const entry = await pollAuditForEvent(page, {
    eventType: "config.changed",
    since: opts.since,
    deadlineMs: 30_000,
    predicate: (e) => {
      const d = e.detail as ConfigChangedDetail | null;
      return d?.authType === "openai-compatible" && d?.provider?.name === opts.providerName;
    },
  });

  expect(entry.outcome).toBe("success");
  const detail = entry.detail as ConfigChangedDetail;
  expect(detail.baseUrlHost).toBe(MOCK_HOST);
  expect(detail.modelCount).toBeGreaterThanOrEqual(1);

  // The key must never appear anywhere in the detail, and the audit must carry
  // only the HOST — never the full base URL (which includes the /v1 path).
  const serialized = JSON.stringify(entry.detail);
  expect(serialized).not.toContain(opts.apiKey);
  expect(serialized).not.toContain(MOCK_BASE_URL);
  expect(serialized).not.toContain("/openai-compatible/v1");
}

test.describe.serial("Setup wizard + settings → OpenAI-compatible provider (#894)", () => {
  test.beforeAll(resetStack);

  test("wizard: OpenAI-compatible provider → Smithers chats via <slug>/mock-large", async ({
    page,
  }) => {
    const since = new Date().toISOString();

    // Phase 1: admin account (mirrors runProviderSmokeTest).
    await page.goto("/setup", { waitUntil: "networkidle" });
    await page.getByLabel(/name/i).fill(ADMIN.name);
    await page.getByLabel(/email/i).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByLabel(/confirm password/i).fill(ADMIN.password);
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page.getByText(/account created successfully/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /continue to sign in/i }).click();

    // Phase 2: sign in.
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel(/email/i).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

    // Phase 3: pick "Custom provider" (wizard-only action below the built-in
    // tiles) and fill the custom form: name + the mock base URL + a dummy key.
    // There's no discover step — the server detects the endpoint's models on
    // save (it fetches the mock's /models), so we go straight to "Add provider".
    await page.getByRole("button", { name: /custom provider/i }).click();
    await page.getByLabel("Name", { exact: true }).fill(WIZARD_PROVIDER_NAME);
    await page.getByLabel("Base URL").fill(MOCK_BASE_URL);
    await page.getByLabel("API key").fill(WIZARD_KEY);

    // Save. The POST discovers the mock's models server-side, sets
    // default_provider=slug (nothing configured yet), and the wizard advances
    // straight into the app. Smithers resolves `<slug>/mock-large`.
    await page.getByRole("button", { name: /^add provider$/i }).click();

    // Landed in the app on the Smithers chat.
    await expect(page).toHaveURL(/\/chat\//, { timeout: 20000 });
    await expect(page.getByText(/i'm smithers/i)).toBeVisible({ timeout: 30000 });

    // The save's config.changed audit is written (host only, no key).
    await assertProviderConfigAudit(page, {
      since,
      providerName: WIZARD_PROVIDER_NAME,
      apiKey: WIZARD_KEY,
    });

    // Phase 4: first chat round-trip through the mock's /chat/completions.
    // Settle past the provider-save's secrets-bootstrap gateway restart before
    // dispatching (see runProviderSmokeTest for the full rationale).
    await waitForOpenClawSettledViaPage(page, { stableForMs: 12000, deadlineMs: 90000 });

    const composer = page.getByPlaceholder(/send a message/i);
    await composer.fill("Hello, are you working?");
    await composer.press("Enter");

    // The mock's canonical reply renders, and no "no API key" / "couldn't
    // respond" error surfaces — proving the custom provider chatted end-to-end.
    await expect(page.getByText(/sure, happy to help/i)).toBeVisible({ timeout: 160000 });
    await expect(page.getByText(/smithers couldn't respond/i)).not.toBeVisible();
    await expect(page.getByText(/no api key found/i)).not.toBeVisible();
  });

  test("settings UI: admin adds a second OpenAI-compatible provider", async ({ page }) => {
    const since = new Date().toISOString();

    // Log back in as the admin from Test 1 (DB persists — resetStack is a
    // once-per-describe beforeAll). Setup is complete + a provider exists, so a
    // sign-in lands straight in the app.
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.getByLabel(/email/i).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20000 });

    // Settings → AI Provider tab. #894 settings redesign: ONE unified grid —
    // Test 1's provider already shows as a TILE among the built-ins, not in a
    // separate "OpenAI-compatible providers" card (that section is gone).
    await page.goto("/settings?tab=provider", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: WIZARD_PROVIDER_NAME })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("OpenAI-compatible providers", { exact: true })).not.toBeVisible();

    // Add a second provider via the grid's dashed "Add custom provider" tile.
    // The form now renders INLINE below the grid (no dialog) — so, unlike the old
    // modal, it no longer makes the rest of the settings page inert, and a
    // page-wide getByLabel("Name") is ambiguous (the settings page has its own
    // "Name" field). Scope the fills to the custom form's own field ids.
    await page.getByRole("button", { name: "Add custom provider" }).click();
    await page.locator("#oai-display-name").fill(SETTINGS_PROVIDER_NAME);
    await page.locator("#oai-base-url").fill(MOCK_BASE_URL);
    await page.locator("#oai-api-key").fill(SETTINGS_KEY);
    await page.getByRole("button", { name: /^add provider$/i }).click();

    // Its config.changed audit is written (host only, no key), distinct from
    // Test 1's row via the provider name predicate.
    await assertProviderConfigAudit(page, {
      since,
      providerName: SETTINGS_PROVIDER_NAME,
      apiKey: SETTINGS_KEY,
    });

    // Both providers now show as tiles in the unified grid. The status indicator
    // lives INSIDE each tile (aria-hidden, so the button's accessible name stays
    // just the provider name): the default tile shows "Default" text, a
    // configured non-default tile shows a quiet check (testid tile-configured).
    const settingsTile = page.getByRole("button", { name: SETTINGS_PROVIDER_NAME, exact: true });
    const wizardTile = page.getByRole("button", { name: WIZARD_PROVIDER_NAME, exact: true });
    await expect(settingsTile).toBeVisible({ timeout: 15000 });
    await expect(wizardTile).toBeVisible();
    // The freshly-added provider isn't the default yet (Test 1's wizard provider
    // still is — it was the sole provider at the time).
    await expect(settingsTile.getByTestId("tile-configured")).toBeVisible();
    await expect(wizardTile.getByTestId("tile-default")).toBeVisible();

    // Select the new tile and use the explicit "Set as default" action (#894 —
    // every provider, built-in or custom, can now be made the default directly
    // instead of only implicitly via a re-save).
    const setDefaultSince = new Date().toISOString();
    await settingsTile.click();
    await page.getByRole("button", { name: "Set as default" }).click();

    // The grid re-labels the new default "Default" (and the old default drops
    // back to the quiet configured check), and a config.changed audit records it.
    await expect(settingsTile.getByTestId("tile-default")).toBeVisible();
    await expect(wizardTile.getByTestId("tile-configured")).toBeVisible();
    const setDefaultEntry = await pollAuditForEvent(page, {
      eventType: "config.changed",
      since: setDefaultSince,
      deadlineMs: 30_000,
      predicate: (e) => (e.detail as ConfigChangedDetail | null)?.newDefault !== undefined,
    });
    expect(setDefaultEntry.outcome).toBe("success");
  });
});

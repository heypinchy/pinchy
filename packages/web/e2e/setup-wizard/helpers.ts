import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "path";
import { expect, type Page } from "@playwright/test";

// Re-using the same docker-compose stack invocation across overlays. Encoded
// as a constant so the test author doesn't accidentally drift between calls.
const COMPOSE_ARGS = [
  "-f docker-compose.yml",
  "-f docker-compose.e2e.yml",
  "-f docker-compose.setup-wizard-test.yml",
].join(" ");

// Playwright runs from `packages/web/` (where playwright.setup-wizard.config.ts
// lives), but the compose files in COMPOSE_ARGS are relative to the repo root.
// Resolve once via process.cwd() and pass as `cwd:` to every execSync call so
// `docker compose -f docker-compose.yml ...` finds the files. (Using
// `import.meta.dirname` here breaks Playwright's CJS-transpile loader on the
// current pin — other e2e helpers like global-setup.ts follow the same
// process.cwd()-based pattern.)
const REPO_ROOT = path.resolve(process.cwd(), "../..");

/**
 * Reset the test stack between specs so each test starts with a fresh
 * "setup wizard not yet completed" state. Truncates Pinchy's app tables
 * (DB stays mounted — pgdata is preserved) and restarts pinchy + openclaw
 * so the new admin account, settings, and agents are recreated cleanly.
 *
 * Volumes are NOT removed. Project memory: never run `docker compose down -v`,
 * even in tests — pgdata is the production DB volume in non-test stacks and
 * the safety habit is more valuable than the marginal cleanup.
 *
 * Table names verified against packages/web/src/db/schema.ts:
 *   users                  → pgTable("user")
 *   sessions               → pgTable("session")
 *   accounts               → pgTable("account")
 *   verification           → pgTable("verification")
 *   agents                 → pgTable("agents")
 *   groups                 → pgTable("groups")
 *   invites                → pgTable("invites")
 *   settings               → pgTable("settings")
 *   auditLog               → pgTable("audit_log")   (NOT "audit_events")
 *   integrationConnections → pgTable("integration_connections")
 *
 * CASCADE handles the dependent join tables (account, user_groups, agent_groups,
 * invite_groups, channel_links, agent_connection_permissions, usage_records).
 */
export async function resetStack(): Promise<void> {
  execSync(
    `docker compose ${COMPOSE_ARGS} exec -T db ` +
      `psql -U pinchy -d pinchy -c ` +
      `'TRUNCATE TABLE "user", account, agents, settings, audit_log, session, verification, groups, invites, integration_connections RESTART IDENTITY CASCADE'`,
    { stdio: "pipe", cwd: REPO_ROOT }
  );

  // Delete openclaw.json and secrets.json from their named volumes BEFORE the
  // container restart. Without this, the next Pinchy regenerate (fired by
  // server.ts:371 when Pinchy reconnects to OpenClaw) builds an "all state
  // truncated" config (~1.2 KB) that's <50% of the previous test's
  // ~4.8 KB config — tripping build.ts's #311 size-drop guard. The guard
  // correctly refuses the write (in production it protects against partial
  // DB-loading races), but here the drop is legitimate (resetStack just
  // wiped everything intentionally). secrets.json is already written by the
  // time the guard fires, so openclaw.json keeps its stale anthropic
  // SecretRef while secrets.json no longer has the key — OpenClaw fails
  // with "JSON pointer segment anthropic does not exist" and crash-loops
  // for the remainder of the test suite. Deleting both files (plus the
  // bootstrap marker) means the next Pinchy regenerate sees no existing
  // file, skips the size-drop comparison, and writes a clean baseline.
  execSync(
    `docker compose ${COMPOSE_ARGS} exec -T openclaw rm -f ` +
      `/root/.openclaw/openclaw.json ` +
      `/openclaw-secrets/secrets.json ` +
      `/openclaw-secrets/.bootstrap-applied`,
    { stdio: "pipe", cwd: REPO_ROOT }
  );

  execSync(`docker compose ${COMPOSE_ARGS} restart pinchy openclaw`, {
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  // Poll /api/setup/status until Pinchy answers — this proves the regenerated
  // openclaw.json has been picked up and the wizard route is reachable.
  // 60 s budget: container restart + Next.js cold compile can run ~30 s.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      execSync(`curl -fsS http://localhost:7777/api/setup/status`, { stdio: "pipe" });
      return;
    } catch {
      // server still warming up
    }
    await sleep(1000);
  }
  throw new Error("Pinchy did not become ready within 60s after reset");
}

export interface ProviderSmokeTestSpec {
  /** Internal provider id used only for log/test diagnostics. */
  provider: "openai" | "anthropic" | "google" | "ollama-cloud";
  /**
   * Regex matching the provider's button label in the wizard. Source of truth
   * is `PROVIDERS[provider].name` in `packages/web/src/components/provider-key-form.tsx`.
   * Examples: /openai/i, /anthropic/i, /^google$/i, /ollama cloud/i.
   */
  buttonName: RegExp;
  /**
   * Regex matching the API-key input's placeholder text. Source of truth is
   * `PROVIDERS[provider].placeholder` in `packages/web/src/lib/providers.ts`.
   * Examples: /sk-/i (OpenAI/Ollama-Cloud), /sk-ant-/i (Anthropic), /AIza/i (Google).
   */
  placeholderRegex: RegExp;
  /**
   * Mock key value. The llm-providers-mock at `config/llm-providers-mock/`
   * accepts any non-empty token, so the literal value doesn't matter for the
   * mock — but using a realistic prefix keeps the test plausible to a reader
   * and protects against future client-side prefix validation.
   */
  keyValue: string;
}

/**
 * End-to-end smoke test for one LLM provider's setup-wizard flow.
 *
 * Drives the wizard through all four phases (admin account, sign-in, provider
 * key entry, first chat) and asserts that the mock LLM's deterministic reply
 * renders without the v0.5.6 secrets.json race surfacing as an inline error.
 *
 * Phase 4 is the actual regression-catcher: before the Task 12 fix, the first
 * chat after wizard completion would race openclaw.json regeneration against
 * secrets.json flush, and Smithers would respond with
 * "No API key found for provider '<provider>'". Asserting the mock reply
 * AND the absence of the error UI catches both halves.
 */
export async function runProviderSmokeTest(page: Page, spec: ProviderSmokeTestSpec): Promise<void> {
  // Phase 1: admin account
  await page.goto("/setup", { waitUntil: "networkidle" });
  await page.getByLabel(/name/i).fill("Smoke Test Admin");
  await page.getByLabel(/email/i).fill("smoke@test.local");
  await page.getByLabel("Password", { exact: true }).fill("smoke-test-password-123");
  await page.getByLabel(/confirm password/i).fill("smoke-test-password-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByText(/account created successfully/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /continue to sign in/i }).click();

  // Phase 2: sign in
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel(/email/i).fill("smoke@test.local");
  await page.getByLabel("Password", { exact: true }).fill("smoke-test-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/setup\/provider/, { timeout: 20000 });

  // Phase 3: provider selection + key entry. Mock accepts any non-empty token.
  // The submit button label in ProviderKeyForm is "Continue" (the default
  // submitLabel) on the setup-wizard path — not "Connect" or "Save", those
  // only appear in /settings/providers where `configuredProviders` is passed.
  await page.getByRole("button", { name: spec.buttonName }).click();
  await page.getByPlaceholder(spec.placeholderRegex).fill(spec.keyValue);
  await page.getByRole("button", { name: /^continue$/i }).click();
  await expect(page.getByText(/provider connected/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /continue to pinchy/i }).click();

  // Phase 4: first message — the bug surface.
  // v0.5.6 race: openclaw.json is regenerated but secrets.json may not be
  // flushed before the first chat hits Gateway → OpenClaw replies with
  // "No API key found for provider '<provider>'" and Pinchy renders an error.
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
  await expect(page.getByText(/i'm smithers/i)).toBeVisible({ timeout: 30000 });

  const composer = page.getByPlaceholder(/send a message/i);
  await composer.fill("Hello, are you working?");
  await composer.press("Enter");

  // Assert: Smithers' response renders. The bug surfaces as the
  // "Smithers couldn't respond — No API key found for provider '<provider>'"
  // toast/inline error. We assert the mock's deterministic content
  // ("Sure, happy to help! What would you like to work on?") and that
  // NO error UI is shown.
  //
  // 90 s budget: the wizard's "Continue" click triggers regenerateOpenClawConfig
  // which writes openclaw.json + secrets.json. OpenClaw's secrets-watcher then
  // pkills the gateway on first-time secrets.json appearance (config/start-openclaw.sh
  // bootstrap-marker logic), and the health-loop respawn cycle is ~40 s.
  // 30 s was too tight on a cold E2E stack — the test would assert before OC
  // finished its first-real-config restart. 90 s covers the worst case
  // (one full restart cycle + chat round-trip).
  await expect(page.getByText(/sure, happy to help/i)).toBeVisible({ timeout: 90000 });
  await expect(page.getByText(/smithers couldn't respond/i)).not.toBeVisible();
  await expect(page.getByText(/no api key found/i)).not.toBeVisible();
}

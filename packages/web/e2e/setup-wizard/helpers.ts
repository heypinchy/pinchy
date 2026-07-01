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
  //
  // This rm runs while OpenClaw is still up (exec needs a running container).
  // OpenClaw's file-watcher sees the deletion as "config file not found" and
  // skips the reload — harmless. The DANGEROUS event is the next one: Pinchy's
  // entrypoint.sh re-seeds a 42-byte `{"gateway":{"mode":"local","bind":"lan"}}`
  // when it finds openclaw.json missing on restart. If OpenClaw's OLD process
  // is still running when that 42-byte seed lands, its file-watcher sees a
  // size-drop (4.9 KB → 42 B) whose diff is missing every restart-class field
  // (gateway.controlUi/auth, discovery, update, canvasHost) → OpenClaw fires a
  // SIGUSR1 gateway restart, and the cascade (compounded by the first-time
  // secrets.json bootstrap pkill) keeps the freshly-created Smithers agent out
  // of OC's runtime `agents.list` for >90 s → the wizard's first chat times out
  // with `unknown agent id` (the google.spec.ts flake; CI run 26840320245).
  //
  // We also delete OpenClaw's config-recovery backups (`openclaw.json.last-good`
  // and the rotating `openclaw.json.bak*` ring). OpenClaw 2026.6.x added
  // startup self-healing: when the on-disk config is a size-drop / missing-meta
  // vs the last-known-good, `recoverConfigFromLastKnownGood` restores
  // `openclaw.json.last-good` over openclaw.json BEFORE Pinchy's regenerate can
  // land. In a reset that stale last-good is the PREVIOUS test's ~20 KB config,
  // which still references provider secrets we just wiped — so OpenClaw would
  // crash-loop on "secrets.providers.pinchy.path is not readable" forever
  // (2026.6.11 upgrade; recovery reads `${configPath}.last-good` and no-ops if
  // the file is absent, so deleting it makes this a true fresh install).
  // `sh -c` gives us glob expansion for the `.bak*` ring.
  execSync(
    `docker compose ${COMPOSE_ARGS} exec -T openclaw sh -c ` +
      `'rm -f /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.last-good /root/.openclaw/openclaw.json.bak* /openclaw-secrets/secrets.json /openclaw-secrets/.bootstrap-applied'`,
    { stdio: "pipe", cwd: REPO_ROOT }
  );

  // Stop OpenClaw BEFORE restarting Pinchy so OC's file-watcher is dead while
  // the config transitions through the 42-byte entrypoint seed and Pinchy's
  // bootInits re-seed. OC only comes back up (further below) once Pinchy has
  // regenerated a complete, restart-class-consistent config — so OC never
  // observes the intermediate size-drop and never enters the SIGUSR1 cascade.
  // `restart: unless-stopped` honours a manual `stop`, so OC stays down until
  // the explicit `start`.
  execSync(`docker compose ${COMPOSE_ARGS} stop openclaw`, {
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  execSync(`docker compose ${COMPOSE_ARGS} restart pinchy`, {
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  // Poll /api/setup/status until Pinchy answers — this proves the regenerated
  // openclaw.json has been picked up and the wizard route is reachable.
  // (Pinchy boots with OC down: its WS connect fails and it falls back to
  // writing openclaw.json directly via writeConfigAtomic — exactly the
  // complete baseline we want on disk before OC starts.)
  // 60 s budget: container restart + Next.js cold compile can run ~30 s.
  const deadline = Date.now() + 60000;
  let pinchyReady = false;
  while (Date.now() < deadline) {
    try {
      execSync(`curl -fsS http://localhost:7777/api/setup/status`, { stdio: "pipe" });
      pinchyReady = true;
      break;
    } catch {
      // server still warming up
    }
    await sleep(1000);
  }
  if (!pinchyReady) throw new Error("Pinchy did not become ready within 60s after reset");

  // Now bring OpenClaw back up. It reads the complete config Pinchy just wrote
  // (restart-class fields present, no agents/providers yet — those arrive via
  // hot-reload when the wizard runs), so its first load is clean and no
  // restart-class diff fires.
  execSync(`docker compose ${COMPOSE_ARGS} start openclaw`, {
    stdio: "pipe",
    cwd: REPO_ROOT,
  });

  // Then wait for OpenClaw to fully SETTLE before handing off to the wizard.
  //
  // The container restart triggers a cold-start config cascade: Pinchy's
  // on-connect `regenerateOpenClawConfig()` rewrites openclaw.json, which OC
  // hot-reloads (and may gateway-restart on). If we start the wizard while this
  // cascade is still in flight, the wizard's OWN config writes (provider save +
  // first-time secrets.json bootstrap pkill) stack on top of it — and OC 5.3's
  // `config.apply` rate-limit (~3/45 s) then defers the agent-list apply by up
  // to ~2 min. That's exactly the 114 s "unknown agent id" gap seen on the
  // ollama-local flake (PR #448, OC log 13:22:04 dispatch → 13:23:58 ready):
  // the first chat raced a storm the resilient dispatch retry then had to
  // absorb. Letting the cold-start cascade drain first keeps the wizard's
  // window small enough that dispatch resilience comfortably covers it.
  //
  // "Settled" = health reports connected & not-restarting continuously for 5 s
  // (a transient reload/restart resets the streak). 60 s budget covers a
  // worst-case cold-start reload cycle while leaving headroom under the 120 s
  // beforeAll timeout (this runs after the ~30 s container restart above).
  const settleDeadline = Date.now() + 60000;
  let connectedSince: number | null = null;
  while (Date.now() < settleDeadline) {
    try {
      const out = execSync(`curl -fsS http://localhost:7777/api/health/openclaw`, {
        stdio: "pipe",
      }).toString();
      const health = JSON.parse(out) as {
        connected?: boolean;
        status?: string;
        configPushesPending?: number;
      };
      // Also require no config push in flight: a parked (rate-limited)
      // config.apply means a change is NOT yet in OC's runtime even though
      // `connected` is true — handing off to the wizard then races the apply.
      if (health.connected && health.status === "ok" && (health.configPushesPending ?? 0) === 0) {
        connectedSince ??= Date.now();
        if (Date.now() - connectedSince >= 5000) return;
      } else {
        connectedSince = null;
      }
    } catch {
      connectedSince = null;
    }
    await sleep(1000);
  }
  throw new Error("OpenClaw did not settle within 60s after reset");
}

/**
 * Poll `/api/health/openclaw` via the Playwright page's request context until
 * OpenClaw reports `connected` continuously for `stableForMs` (a transient
 * reload/restart resets the streak), or `deadlineMs` elapses. Used to wait out
 * the secrets-bootstrap gateway restart before dispatching the first chat.
 *
 * Mirrors the settle loop in `resetStack` but runs in a page context (uses
 * `page.request` instead of `execSync`) and takes a configurable, longer
 * stability window — the post-provider-save restart can start a few seconds
 * after the save, so a short streak could otherwise pass on the pre-restart
 * connected state.
 */
async function waitForOpenClawSettledViaPage(
  page: Page,
  opts: { stableForMs: number; deadlineMs: number }
): Promise<void> {
  const deadline = Date.now() + opts.deadlineMs;
  let connectedSince: number | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get("/api/health/openclaw");
      if (res.ok()) {
        const health = (await res.json()) as {
          connected?: boolean;
          status?: string;
          configPushesPending?: number;
        };
        // Require no config push in flight before the first chat: the wizard's
        // provider save triggers a regenerate whose `models` block may be
        // parked in OC's config.apply rate-limit window. Dispatching into that
        // gap makes the run resolve the agent's model against a runtime that
        // doesn't have the provider yet ("Unknown model: google/…", the google
        // setup-wizard flake). The chat path's own model-race retry remains the
        // production backstop; this keeps the test's common case fast & clean.
        if (health.connected && health.status === "ok" && (health.configPushesPending ?? 0) === 0) {
          connectedSince ??= Date.now();
          if (Date.now() - connectedSince >= opts.stableForMs) return;
        } else {
          connectedSince = null;
        }
      } else {
        connectedSince = null;
      }
    } catch {
      connectedSince = null;
    }
    await sleep(1000);
  }
  // Don't throw — fall through and let the chat assertion's own retry budget
  // run. A failure here would mask the real assertion's diagnostic.
}

export interface ProviderSmokeTestSpec {
  /** Internal provider id used only for log/test diagnostics. */
  provider: "openai" | "anthropic" | "google" | "ollama-cloud" | "ollama-local";
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

  // Wait for OpenClaw to SETTLE past the provider-save's secrets-bootstrap
  // restart BEFORE sending the first chat. Saving the provider key writes the
  // first-ever secrets.json, which trips start-openclaw.sh's secrets-watcher
  // → a one-shot gateway pkill+respawn (~40 s). If we dispatch into that
  // window, OC rejects with `unknown agent id` until the restart applies the
  // agent — and the chat path's own bounded retry (chatWithDispatchRaceRetry,
  // ~90 s) sometimes can't outlast a slow-CI restart, so the assert below
  // times out (the google/anthropic ~33 % flake, CI run 26843343975 + reruns).
  // Settling here means the dispatch lands on a ready runtime and the response
  // is fast — without masking the actual regression (the "No API key" /
  // "couldn't respond" content assertions below still fire if secrets didn't
  // flush). "Settled" = connected continuously for 12 s; the restart breaks
  // the streak, so a 12 s streak proves we're past it. 90 s deadline covers a
  // worst-case respawn; happy path exits in ~12 s.
  await waitForOpenClawSettledViaPage(page, { stableForMs: 12000, deadlineMs: 90000 });

  const composer = page.getByPlaceholder(/send a message/i);
  await composer.fill("Hello, are you working?");
  await composer.press("Enter");

  // Assert: Smithers' response renders. The bug surfaces as the
  // "Smithers couldn't respond — No API key found for provider '<provider>'"
  // toast/inline error. We assert the mock's deterministic content
  // ("Sure, happy to help! What would you like to work on?") and that
  // NO error UI is shown.
  //
  // 160 s budget: must outlast the chat path's server-side
  // chatWithDispatchRaceRetry (150 s — see chat-dispatch-retry.ts). The
  // wizard's "Continue" triggers regenerateOpenClawConfig + the first-ever
  // secrets.json, so OC pkills+respawns the gateway (~40 s) and the new
  // Smithers agent's apply can lag; on the FIRST provider spec (cold initial
  // stack) the apply was measured ~108 s after the chat. A 90 s client-side
  // assertion gave up before the 150 s server-side retry could land the
  // dispatch — the residual setup-wizard flake (CI run 26868364630, the
  // anthropic spec; the warmer later specs settle in ~20 s). 160 s sits just
  // past the server budget. The settle above keeps the common case fast.
  await expect(page.getByText(/sure, happy to help/i)).toBeVisible({ timeout: 160000 });
  await expect(page.getByText(/smithers couldn't respond/i)).not.toBeVisible();
  await expect(page.getByText(/no api key found/i)).not.toBeVisible();
}

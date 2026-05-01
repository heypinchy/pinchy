/**
 * E2E regression for #193: creating an agent must NOT trigger a full
 * gateway restart on a stable stack.
 *
 * Background — staging-observed cascade (2026-05-01):
 *   Pinchy's `regenerateOpenClawConfig()` was non-idempotent for
 *   `channels.telegram.enabled`. OpenClaw's auto-enable step writes
 *   `enabled: true` back to openclaw.json on every gateway start;
 *   Pinchy's preservation allow-list lacked the field, so the next
 *   regenerate (e.g. POST /api/agents) stripped it. OpenClaw then
 *   diff'd the file, decided the change required a full process restart,
 *   restarted, auto-enabled again, re-added the field — endless loop.
 *   User-visible symptom: "Agent runtime is not available right now"
 *   banner for 15-30 s after every settings save.
 *
 * What this test reproduces:
 *   1. Wait for stable connectivity (cold-start cascade settled — this
 *      is the part that made the previous E2E (#203 then dropped in
 *      6d516585e) flaky; here it's pure setup, never raced against).
 *   2. POST /api/agents with a fresh custom agent.
 *   3. Read OpenClaw logs for the next 10 s and assert:
 *      a) `agents.list` reload event WAS detected — proves the config
 *         push reached runtime (regression for #200 fix).
 *      b) NO `requires gateway restart` line — the bug fingerprint.
 *      c) NO `received SIGUSR1` line — defense-in-depth in case OpenClaw
 *         renames the restart-trigger log shape.
 *
 * Robustness choices vs the dropped agent-hot-reload.spec.ts:
 *   - No browser, no LLM round-trip, no chat WebSocket assertion.
 *     Removes Playwright timing flakes, model-prewarm timeouts, and
 *     mock-provider auth races as causes of false failures.
 *   - Deterministic log scan with a timestamp `--since` window, not
 *     "wait for some text to appear in the UI within X seconds."
 *   - Stable-wait is setup-only (15 s of continuous connectivity before
 *     the test action), not a race-during-test.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { resolve } from "path";
import {
  login,
  getAgentId,
  connectBot,
  resetMockTelegram,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  waitForTelegramPolling,
  seedSetup,
  pinchyPost,
} from "./helpers";

const BOT_TOKEN = "123456:ABC-no-restart-cascade";
const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";

// docker compose must run from the repo root where the compose files live.
// Playwright's cwd is `packages/web/`, so resolve up two levels. Also set
// PINCHY_VERSION because the production-image overlay (docker-compose.yml)
// requires it for `image:` interpolation; any non-empty string works.
const REPO_ROOT = resolve(__dirname, "../../../..");
const COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.test.yml";
const COMPOSE_ENV = { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" };

function openClawLogsSince(sinceIso: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} logs openclaw --since "${sinceIso}" 2>&1`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: COMPOSE_ENV,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Wait until the OpenClaw gateway has been quiet (no restart events) for
 * at least `quietMs`. WS connectivity alone is unreliable: a hot-reload
 * doesn't drop the WS, but a full restart 10–20 s later still ruins the
 * test. We scan OpenClaw's logs directly for the canonical restart
 * markers and require them to be older than `quietMs`.
 *
 * Markers we treat as "restart happened" (any of):
 *   - `[gateway] received SIGUSR1; restarting`
 *   - `[reload] config change requires gateway restart`
 *   - `[gateway] received SIGTERM; shutting down` (start-openclaw.sh kill)
 *   - `[gateway] ready (` (gateway came back up — last ready means last restart finished)
 */
async function waitForOpenClawQuiet(quietMs = 30000, timeout = 240000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const logs = openClawLogsSince(new Date(Date.now() - quietMs - 5000).toISOString());
    const restartMarkers = logs
      .split("\n")
      .filter((l) =>
        /received SIGUSR1|received SIGTERM|requires gateway restart|\[gateway\] ready \(/.test(l)
      );
    if (restartMarkers.length === 0) {
      // No restart-related events in the look-back window → gateway is quiet.
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`OpenClaw never quiet for ${quietMs}ms within ${timeout}ms`);
}

test.describe.serial("Agent create — no gateway restart cascade (#193)", () => {
  let smithersAgentId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(360000);
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    await resetMockTelegram();
    await waitForOpenClawConnected(120000);
    await login();

    smithersAgentId = await getAgentId();

    // Telegram MUST be configured for this bug to be reproducible — the
    // ping-pong loop is driven by OpenClaw's auto-enable side-effect on
    // `channels.telegram.enabled`. Without a configured account, Pinchy
    // never emits the channels.telegram block at all.
    await connectBot(smithersAgentId, BOT_TOKEN);
    await waitForTelegramPolling();

    // After connectBot, OpenClaw restarts to pick up the new bot account.
    // Wait until logs show no restart activity for 30 s.
    await waitForOpenClawQuiet();

    // Warm-up regenerate. After a fresh gateway start, OpenClaw's reload
    // subsystem keeps the config it loaded at startup as `currentCompareConfig`.
    // If that config is sparse (e.g. an early Pinchy write before
    // seedSetup populated provider/bot settings), the FIRST Pinchy
    // regenerate after gateway boot diffs against the sparse baseline —
    // showing 6+ paths as changed (env, plugins.allow, plugins.entries.telegram,
    // bindings, channels, session) regardless of what actually changed at
    // the user level. The first restart-trigger paths there bypass our
    // env-redact workaround because file-watcher's diff doesn't go through
    // `restoreRedactedValues`.
    //
    // To establish a baseline that matches Pinchy's full regenerated config,
    // do an explicit warm-up agent create here. Cascade resolves, baseline
    // updates, then the actual test action below has a true small diff.
    const warmupRes = await pinchyPost("/api/agents", {
      name: `Warmup-${Date.now()}`,
      templateId: "custom",
    });
    expect(warmupRes.status, await warmupRes.text()).toBeLessThan(300);

    // The warmup's config.apply propagates async (fire-and-forget). Sleep
    // long enough for any restart cascade to start showing in the OpenClaw
    // logs — without this, the immediately-following waitForOpenClawQuiet
    // can scan logs BEFORE the restart marker appears and return false-quiet.
    await new Promise((r) => setTimeout(r, 5000));
    await waitForOpenClawQuiet();
  });

  test("POST /api/agents triggers a hot-reload, not a full gateway restart", async () => {
    // Mark log position with one second of slack on each side. `docker
    // compose logs --since` precision is whole seconds.
    const beforeMark = new Date(Date.now() - 1000).toISOString();

    const createRes = await pinchyPost("/api/agents", {
      name: `NoRestartTest-${Date.now()}`,
      templateId: "custom",
    });
    expect(createRes.status, await createRes.text()).toBeLessThan(300);

    // Give OpenClaw 10 s to process the config.apply RPC. A real restart
    // takes ~12 s (SIGUSR1 → process exit → respawn → ready); 10 s would
    // catch the SIGUSR1 line at minimum if a restart was triggered, even
    // if the new gateway hasn't reported ready yet.
    await new Promise((r) => setTimeout(r, 10000));

    const logs = openClawLogsSince(beforeMark);

    // (a) Positive: the config change reached OpenClaw and was evaluated
    //     for reload. Without this, we'd be testing nothing — the config
    //     push silently failing would also satisfy (b) but means our fix
    //     is being bypassed.
    expect(logs, logs).toMatch(/\[reload\] config change detected.*agents\.list/);

    // (b) The bug fingerprint. With the bug present, OpenClaw logs:
    //     "[reload] config change requires gateway restart (...)"
    //     "[gateway] received SIGUSR1; restarting"
    //     "[gateway] restart mode: full process restart"
    //     None of these should appear if the config diff is only on
    //     hot-reloadable paths (`agents.list`, `bindings`).
    expect(logs, logs).not.toMatch(/requires gateway restart/);
    expect(logs, logs).not.toMatch(/received SIGUSR1/);
    expect(logs, logs).not.toMatch(/full process restart/);
  });
});

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
 *      is the part that made the previous E2E from #203 flaky and got
 *      it dropped; here it's pure setup, never raced against).
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

// Same bot token as telegram-flow.spec.ts. The Telegram E2E suites share Smithers
// across spec files, and this one runs first (alphabetical). If we connected with
// a *different* token here, telegram-flow's test 3 connectBot would rotate the
// token on the same agent — and OpenClaw's targeted-write inotify path doesn't
// reliably restart the channel on token-rotation, so the second polling provider
// never picks up the new token. The bot reply for test 4 then queues under one
// token while the live polling runner is on the other (#flake-test-4-test-10).
//
// Sharing the literal here is the simplest defense: test 3's connectBot sees
// "same token already configured", file-write is a no-op (current === newContent),
// nothing destabilizes the running poller. The /api/agents endpoint we actually
// exercise here doesn't care about the token text — it only needs *some* main
// Telegram bot configured to satisfy hasMainTelegramBot().
const BOT_TOKEN = "123456:ABC-test-token-for-e2e";

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
 * TCP-probe OpenClaw's gateway port via `docker compose exec`. A successful
 * TCP connect is a definitive "the Node.js event loop is processing
 * accept()s" signal — independent of log activity, which goes silent when
 * OC is genuinely idle (no SIGUSR1, no reloads, no WS traffic from Pinchy).
 *
 * Used by `waitForOpenClawQuiet` to disambiguate "OC is quiet because nothing
 * is happening" (✓ test should return) from "OC's event loop is blocked"
 * (✗ keep waiting). The previous heuristic was "any log line in the last
 * 10 s" — that broke after the restart-cascade fix because the test's
 * subject (idle OC) genuinely produces zero logs for 30+ s once Pinchy
 * stops issuing applies, and the heuristic interpreted that as a hang.
 *
 * Implementation note: probe via the OpenClaw container's bundled `node`
 * (always present in the openclaw image — `npm install -g openclaw@…`).
 * Don't reach for `sh -c 'echo > /dev/tcp/...'` — Debian/Ubuntu base images
 * symlink `/bin/sh` to `dash`, which does NOT implement bash's `/dev/tcp`
 * pseudo-device, so the redirect would silently fail with "No such file or
 * directory" and the probe would report unresponsive even when the port is
 * up. node's `net.connect` works regardless of shell.
 */
function isOpenClawPortResponsive(): boolean {
  try {
    execSync(
      `docker compose ${COMPOSE_FILES} exec -T openclaw node -e ` +
        `"require('net').createConnection(18789,'127.0.0.1').on('connect',function(){this.end();process.exit(0)}).on('error',function(){process.exit(1)})"`,
      { cwd: REPO_ROOT, env: COMPOSE_ENV, stdio: "pipe", timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
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
 *   - `[gateway] ready` — included intentionally even though it's the
 *     trailing edge of a restart, not the leading edge: every cold-start
 *     stack emits at least one of these. By treating it as a marker we
 *     correctly wait `quietMs` after the gateway becomes operational, not
 *     just after the SIGUSR1 fires.
 *
 * Liveness guard: an empty log window is ambiguous — could be "OC's Node.js
 * event loop blocked" (CI load, 30+ s zero-log stalls observed at
 * eventLoopDelayMaxMs=6526 ms) or "OC is genuinely idle, doing nothing
 * because nothing is happening on the gateway". The cascade-restart fix on
 * this branch eliminated the SIGUSR1 storm that previously kept producing
 * log activity, so post-fix idle OC sustains 30+ s of zero logs in the
 * normal happy path. We can't distinguish via logs — so we TCP-probe the
 * gateway port as the definitive liveness signal. A successful connect
 * means the Node.js event loop is processing accept()s, ergo not blocked.
 */
async function waitForOpenClawQuiet(quietMs = 30000, timeout = 240000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const logs = openClawLogsSince(new Date(Date.now() - quietMs - 5000).toISOString());
    const restartMarkers = logs
      .split("\n")
      .filter((l) =>
        /received SIGUSR1|received SIGTERM|requires gateway restart|\[gateway\] ready/.test(l)
      );
    if (restartMarkers.length === 0) {
      if (!isOpenClawPortResponsive()) {
        // Port unreachable → event loop blocked or container down. Keep
        // waiting (a real container crash will surface as the outer timeout).
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
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
    const warmupMark = new Date(Date.now() - 1000).toISOString();
    const warmupRes = await pinchyPost("/api/agents", {
      name: `Warmup-${Date.now()}`,
      templateId: "custom",
    });
    expect(warmupRes.status, await warmupRes.text()).toBeLessThan(300);

    // The warmup's config.apply propagates async (fire-and-forget). Wait
    // until OpenClaw has actually OBSERVED the warmup before doing anything
    // else. A bare 5s sleep + waitForOpenClawQuiet can return false-quiet
    // when OpenClaw's event loop is blocked (no logs at all in the lookback
    // window even though config.apply work is queued). Polling for the
    // warmup's reload-detected line guarantees the cascade — if any —
    // happens here, not during the test assertion below.
    const warmupDeadline = Date.now() + 90000;
    while (Date.now() < warmupDeadline) {
      const logs = openClawLogsSince(warmupMark);
      if (/\[reload\] config change detected.*agents/.test(logs)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Then absorb any restart cascade triggered by the warmup before continuing.
    await waitForOpenClawQuiet();

    // Localize failures: if the warmup itself triggered a restart, the
    // cascade is from a setup-stage problem (sparse-baseline, env
    // propagation, etc.) — not from the test action. Failing here points
    // a finger at the right cause; failing in the assertion below would
    // misleadingly look like the production fix doesn't work. Note: a
    // restart in the warmup window is acceptable in some staging-cold
    // scenarios, so we tolerate it but log a warning instead of failing
    // hard. The test assertion remains the source of truth.
    const warmupLogs = openClawLogsSince(warmupMark);
    if (/requires gateway restart/.test(warmupLogs)) {
      console.warn(
        "[warmup] gateway restarted during warmup — beforeAll is recovering, but this means the cold-start baseline was sparse. " +
          "If the actual assertion below fails with the same restart fingerprint, the warmup didn't actually establish a stable baseline."
      );
    }
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
    // Note: OpenClaw ≥ 4.27 changed the log format from
    //   "config change detected.*agents.list"
    // to
    //   "config change detected; evaluating reload (env, agents, ...)"
    // so we match the common prefix + "agents" to cover both formats.
    expect(logs, logs).toMatch(/\[reload\] config change detected.*agents/);

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

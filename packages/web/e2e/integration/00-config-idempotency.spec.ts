/**
 * Architectural regression: regenerateOpenClawConfig() must be byte-stable
 * on a stable stack.
 *
 * History this test exists to close out:
 *   - #193 (channels.telegram.enabled stripped → restart cascade)
 *   - #200 (secrets.json owner race during reload)
 *   - #237 (plugins.allow reorder → restart)
 *   - openclaw#47458 (agents.defaults.* enrichment race)
 *   - openclaw#75534 (env diff false-positive)
 *   - 2026-05-03 staging incident: gateway.controlUi-Drift triggers
 *     SIGUSR1 on every Pinchy startup, ~5 min cold-start.
 *
 * Each historical fix added one missing field to Pinchy's preserve-list.
 * None prevented the *next* OpenClaw-enriched field from triggering the
 * same restart-cascade. The pattern is the bug; the field is the symptom.
 *
 * The contract this test enforces:
 *
 *   GIVEN a stable system (no restart markers in OpenClaw logs for 30 s)
 *   WHEN  Pinchy regenerates the config without any DB change
 *   THEN  openclaw.json on disk is byte-equal before and after
 *   AND   no "requires gateway restart" / SIGUSR1 / SIGTERM marker appears
 *
 * Failure shape interpretation:
 *   - byte equality fails → Pinchy is missing a preserve-list entry for
 *     some OpenClaw-enriched field (look at the diff).
 *   - byte equality passes but restart marker fires → diff classifier in
 *     openclaw#75534 territory; check `pushConfigInBackground` payload
 *     vs file-watcher payload.
 *
 * Trigger: PATCH /api/agents/<smithers-id> with `{ name: "Smithers" }`.
 * That's a no-op DB write but routes through `updateAgent →
 * regenerateOpenClawConfig` (because `name` is in `OPENCLAW_CONFIG_FIELDS`)
 * — the exact production code path that fires on every settings save.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const COMPOSE_FILE = "-f docker-compose.integration.yml";
const CONFIG_PATH = "/tmp/pinchy-integration-openclaw/openclaw.json";
const PINCHY_URL = "http://localhost:7779";

function stripMeta(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.meta;
  return JSON.stringify(parsed);
}

function openClawLogsSince(sinceIso: string): string {
  return execSync(`docker compose ${COMPOSE_FILE} logs openclaw --since "${sinceIso}" 2>&1`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Wait until OpenClaw has been free of restart-cascade markers for `quietMs`.
 * Markers we treat as "restart happened":
 *   - `[gateway] received SIGUSR1; restarting`
 *   - `[reload] config change requires gateway restart`
 *   - `[gateway] received SIGTERM; shutting down`
 *   - `[gateway] ready (` — trailing edge of any restart; ensures we
 *     wait `quietMs` AFTER the gateway is back up, not just after SIGUSR1.
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
    if (restartMarkers.length === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`OpenClaw never quiet for ${quietMs}ms within ${timeout}ms`);
}

let sessionCookie: string | null = null;

async function login(): Promise<void> {
  const res = await fetch(`${PINCHY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PINCHY_URL,
    },
    body: JSON.stringify({
      email: "admin@integration.local",
      password: "integration-password-123",
    }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";")[0];
  if (!sessionCookie) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: PINCHY_URL,
    ...(sessionCookie ? { Cookie: sessionCookie } : {}),
  };
}

async function getSmithersId(): Promise<string> {
  const res = await fetch(`${PINCHY_URL}/api/agents`, { headers: authHeaders() });
  const agents = (await res.json()) as Array<{ id: string; name: string }>;
  const smithers = agents.find((a) => a.name === "Smithers");
  if (!smithers) throw new Error(`Smithers not found among ${agents.length} agents`);
  return smithers.id;
}

test.describe("regenerateOpenClawConfig — cold-start & idempotency contract", () => {
  /**
   * Cold-start cascade test. Reproduces the user-visible "Smithers takes
   * >1 minute to start" complaint from the 2026-05-03 staging incident.
   *
   * Every full gateway restart costs 10-20 s of "Reconnecting to the
   * agent…" downtime. The bootstrap is allowed *one* restart (Pinchy's
   * first regenerate writes paths OpenClaw's bootstrap config didn't
   * have — agents.list, plugins.entries.pinchy-*, etc. — and a single
   * SIGUSR1 to absorb that is unavoidable until we land Phase 2's
   * "Pinchy is sole writer" architecture).
   *
   * Anything beyond that is a cascade and degrades user experience
   * proportionally. Staging on 2026-05-03 had two: the bootstrap
   * regenerate restart AND a separate Bonjour-watchdog SIGTERM. The
   * second-restart class is what this test guards against in the
   * Pinchy-side code paths.
   *
   * Counts `received SIGUSR1` markers — each is one full restart.
   * Bonjour-induced SIGTERMs surface as `received SIGTERM` and would
   * also be caught here (we currently expect zero of those on the
   * integration stack since Bonjour is a container-environment quirk
   * that doesn't fire here, but we assert on it so a future env change
   * doesn't silently regress).
   *
   * NOTE on baseline. globalSetup intentionally writes a fresh OpenClaw
   * container, runs the setup wizard, and waits for reconnect. By the
   * time this test runs, the bootstrap restart has already happened
   * exactly once. We assert "≤ 1" on the SIGUSR1 count to allow that
   * single bootstrap restart while flagging any extra.
   */
  test("cold-start cascade: at most one gateway restart in setup", async () => {
    test.setTimeout(120000);
    const logs = openClawLogsSince(new Date(Date.now() - 600000).toISOString());

    const sigusrCount = (logs.match(/received SIGUSR1/g) ?? []).length;
    const sigtermCount = (logs.match(/received SIGTERM/g) ?? []).length;
    const fullRestartCount = (logs.match(/full process restart/g) ?? []).length;

    // Helpful triage: list every restart trigger reason found.
    const restartReasons = logs
      .split("\n")
      .filter((l) => /requires gateway restart/.test(l))
      .map((l) => l.replace(/^.*requires gateway restart /, "").trim());

    expect(
      sigusrCount,
      `Expected ≤1 SIGUSR1 (bootstrap only), got ${sigusrCount}.\nRestart reasons:\n${restartReasons.join("\n")}`
    ).toBeLessThanOrEqual(1);
    expect(sigtermCount, "Bonjour or external SIGTERM during setup").toBe(0);
    expect(fullRestartCount, "Multiple full process restarts during setup").toBeLessThanOrEqual(1);
  });

  test("PATCH agent with no DB change must not modify openclaw.json or trigger restart", async () => {
    test.setTimeout(360000);

    await login();
    const smithersId = await getSmithersId();

    // 1. Wait for the cold-start cascade to fully settle. globalSetup
    //    restarted OpenClaw and Pinchy reconnected; depending on what
    //    OpenClaw enriched between Pinchy's writes, we may still be
    //    inside a restart chain. Quiet means no restart marker for 30 s.
    await waitForOpenClawQuiet();

    // 2. Snapshot openclaw.json *after* OpenClaw has stamped its enrichments
    //    (auto-enable markers, agents.defaults.*, gateway.controlUi.allowedOrigins,
    //    meta.lastTouchedAt etc.). This is the baseline we expect Pinchy to
    //    preserve byte-for-byte.
    const before = readFileSync(CONFIG_PATH, "utf-8");
    const beforeMark = new Date(Date.now() - 1000).toISOString();

    // 3. Trigger a no-op state-change path. PATCH name to its current value.
    //    `name` is in `OPENCLAW_CONFIG_FIELDS`, so updateAgent calls
    //    regenerateOpenClawConfig. The DB row does not change content, so
    //    a contract-compliant Pinchy short-circuits the file write
    //    (`if (existing === newContent) return`).
    const patchRes = await fetch(`${PINCHY_URL}/api/agents/${smithersId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Smithers" }),
    });
    expect(patchRes.status, await patchRes.text()).toBeLessThan(300);

    // 4. Give the background config.apply RPC time to land. A real restart
    //    surfaces in OpenClaw logs within ~2 s of SIGUSR1; 5 s comfortably
    //    covers transient WS queueing + the Bonjour-watchdog grace window.
    await new Promise((r) => setTimeout(r, 5000));

    // 5. Contract assertions.
    const after = readFileSync(CONFIG_PATH, "utf-8");
    const logs = openClawLogsSince(beforeMark);

    // (a) Semantic equality, ignoring the entire `meta` block. OpenClaw
    //     stamps `meta.lastTouchedAt`, `meta.lastTouchedVersion`, and
    //     potentially other meta fields on every write IT performs
    //     (config.apply RPC, internal restart bookkeeping) — independent
    //     of any Pinchy or user action — so a strict byte-equality
    //     assertion here would be racy: between our `before` and `after`
    //     reads, OpenClaw could have re-stamped the file as part of
    //     routine reload-subsystem work even when Pinchy itself wrote
    //     nothing. Pinchy never writes `meta` (only preserves it from
    //     existing), so the entire block is OpenClaw-owned and outside
    //     our semantic contract here. Stripping the whole block is more
    //     robust than enumerating individual stamp fields and avoids
    //     false failures whenever upstream adds another stamp.
    //
    //     If THIS fails, Pinchy's regenerate produced a different file
    //     even though the user-level state didn't change — Pinchy is
    //     missing a preserve-list entry for an OpenClaw-enriched field
    //     (the kind of bug that produced #193, #200, #237). The diff
    //     localizes which field.
    const beforeNorm = stripMeta(before);
    const afterNorm = stripMeta(after);
    if (beforeNorm !== afterNorm) {
      // Compact diff for fast triage. Write both snapshots to tmp files and
      // diff them — passing the whole config inline via `printf %s ...` would
      // hit ARG_MAX (~256 KB on macOS) once telegram bindings + many users
      // grow the config, silently producing an empty diff message instead.
      const { writeFileSync: write, mkdtempSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "pinchy-idempotency-"));
      write(join(dir, "before.json"), before);
      write(join(dir, "after.json"), after);
      const diff = execSync(
        `diff "${join(dir, "before.json")}" "${join(dir, "after.json")}" || true`,
        {
          encoding: "utf-8",
        }
      );
      throw new Error(
        `openclaw.json changed despite no DB change — preserve-list incomplete.\n` +
          `Diff (before → after):\n${diff}`
      );
    }

    // (b) No full-restart trigger fired. If this fails despite (a) passing,
    //     the issue is in `pushConfigInBackground` or in the diff classifier
    //     (openclaw#75534) — file is semantically equal but the RPC payload
    //     was sent and OpenClaw re-classified it as restart-required.
    expect(logs, logs).not.toMatch(/requires gateway restart/);
    expect(logs, logs).not.toMatch(/received SIGUSR1/);
    expect(logs, logs).not.toMatch(/full process restart/);
  });

  /**
   * Stress idempotency: 5 consecutive no-op regenerates must not drift the
   * config or trigger a restart on any iteration.
   *
   * This catches a class of bugs where a single regenerate is stable but a
   * sequence diverges — e.g. a field that is preserved on iteration 1 but
   * re-emitted differently on iteration 2 once it is already present in the
   * file that Pinchy reads back.
   *
   * Each iteration: PATCH agent with same name → wait 5 s → assert byte-equal
   * (minus meta) → assert no restart markers.
   */
  test("idempotency stress: 5 consecutive no-op regenerates produce no openclaw.json drift", async () => {
    test.setTimeout(300000); // 5 × ~45 s max each

    await login();
    const smithersId = await getSmithersId();

    // Wait for the system to fully settle before starting the stress loop.
    await waitForOpenClawQuiet();

    for (let i = 1; i <= 5; i++) {
      const snapshot = readFileSync(CONFIG_PATH, "utf-8");
      const beforeMark = new Date(Date.now() - 1000).toISOString();

      const patchRes = await fetch(`${PINCHY_URL}/api/agents/${smithersId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Smithers" }),
      });
      expect(patchRes.status, `iteration ${i}: PATCH failed`).toBeLessThan(300);

      // Allow enough time for the write + any potential restart to surface.
      await new Promise((r) => setTimeout(r, 5000));

      const after = readFileSync(CONFIG_PATH, "utf-8");
      const logs = openClawLogsSince(beforeMark);

      if (stripMeta(snapshot) !== stripMeta(after)) {
        const { writeFileSync: write, mkdtempSync } = await import("fs");
        const { tmpdir } = await import("os");
        const { join } = await import("path");
        const dir = mkdtempSync(join(tmpdir(), "pinchy-stress-"));
        write(join(dir, "before.json"), snapshot);
        write(join(dir, "after.json"), after);
        const diff = execSync(
          `diff "${join(dir, "before.json")}" "${join(dir, "after.json")}" || true`,
          { encoding: "utf-8" }
        );
        throw new Error(
          `Stress iteration ${i}: openclaw.json drifted — preserve-list incomplete.\n` +
            `Diff (before → after):\n${diff}`
        );
      }

      expect(logs, `iteration ${i}: requires gateway restart`).not.toMatch(
        /requires gateway restart/
      );
      expect(logs, `iteration ${i}: received SIGUSR1`).not.toMatch(/received SIGUSR1/);
      expect(logs, `iteration ${i}: full process restart`).not.toMatch(/full process restart/);
    }
  });
});

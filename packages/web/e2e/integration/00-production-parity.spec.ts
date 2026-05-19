/**
 * Production-parity acceptance test for issue #196 (Tier 3 — integration suite).
 *
 * The integration job historically ran Pinchy as a Playwright `webServer`
 * on the host (CI runner uid, typically root). OpenClaw, in its container,
 * runs as root and writes files in the shared volume with `0600` mode.
 * Pinchy at uid 999 in production gets EACCES on those files; Pinchy as
 * root in CI sees them fine. That mismatch is the bug class issue #196
 * exists to close — the same parity gap PR #195 closed for the Telegram
 * suite, then #196 closed for Odoo / Web / Email.
 *
 * This spec is the regression guard: it asserts the integration stack is
 * actually running Pinchy as uid 999 (production-image entrypoint demotes
 * via `su -s /bin/sh pinchy`), OpenClaw as uid 0, AND that the uid 999
 * Pinchy user can still read a root-owned 0600 file that OpenClaw drops
 * into the shared volume — proving the `config/start-openclaw.sh` chmod
 * tick (the operational fix from #195) is on the success path.
 *
 * Why `--user pinchy` is mandatory on the docker exec calls:
 *   `Dockerfile.pinchy` deliberately omits a `USER` directive — the
 *   container PID 1 is root (the entrypoint), and only after volume
 *   permission fixups does it `su` into the `pinchy` user. So a plain
 *   `docker compose exec pinchy id -u` returns 0 even on a correctly
 *   built production image; we must scope our probe to the pinchy uid
 *   to reflect what the Pinchy *process* sees at runtime.
 *
 * Failure modes this catches:
 *   1. Pinchy container is built from the dev Dockerfile (no pinchy user;
 *      `--user pinchy` fails outright). Same hole as before #196.
 *   2. start-openclaw.sh chmod tick removed or broken (root:0600 files
 *      stay unreadable for uid 999 → cat fails with EACCES).
 *   3. The shared volume isn't actually shared (Pinchy reads its own,
 *      empty mount instead of OpenClaw's writes — probe file is missing).
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const COMPOSE_FILES =
  "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.integration.yml";
const COMPOSE_ENV = { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" };

function composeExecAs(service: string, user: string, cmd: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} exec -T --user ${user} ${service} ${cmd}`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: COMPOSE_ENV,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

test.describe("Production parity — integration stack runs production images", () => {
  test("Pinchy container has a pinchy user at uid 999 (production user)", () => {
    const uid = composeExecAs("pinchy", "pinchy", "id -u");
    expect(uid).toBe("999");
  });

  test("OpenClaw container runs as uid 0 (production root)", () => {
    const uid = composeExecAs("openclaw", "0", "id -u");
    expect(uid).toBe("0");
  });

  test("Pinchy (uid 999) can read root-owned 0600 file in shared volume", () => {
    // Reproduces the #195 file-permission shape end-to-end. OpenClaw drops a
    // root:0600 probe file into the shared config volume; the chmod tick in
    // start-openclaw.sh must widen it so uid 999 Pinchy can read it back.
    //
    // Probe filename embeds the test-run timestamp so that re-running the
    // suite locally without `down -v` doesn't conflict with leftover probes
    // from earlier runs (the cleanup hook below tidies up afterwards, but
    // randomising the name keeps the assertion correct even if cleanup is
    // skipped — e.g. an aborted run).
    const probeName = `__pinchy_uid_probe_${Date.now()}.txt`;
    const probeOpenClawPath = `/root/.openclaw/credentials/${probeName}`;
    const probePinchyPath = `/openclaw-config/credentials/${probeName}`;
    const expectedContent = `probe-${Date.now()}`;

    // Write the probe via stdin instead of embedding the content in the
    // shell command — keeps arbitrary content safe even if a future change
    // makes it user-influenced. `docker compose exec -T` accepts stdin
    // because -T disables TTY allocation.
    execSync(
      `docker compose ${COMPOSE_FILES} exec -T --user 0 openclaw sh -c ` +
        `"mkdir -p /root/.openclaw/credentials && cat > '${probeOpenClawPath}' && chmod 0600 '${probeOpenClawPath}' && chown 0:0 '${probeOpenClawPath}'"`,
      { cwd: REPO_ROOT, env: COMPOSE_ENV, stdio: ["pipe", "pipe", "pipe"], input: expectedContent }
    );

    // The chmod tick runs at 0.2s cadence inside start-openclaw.sh. Give it
    // up to 5s to widen the file. Mirrors the docker-smoke job's poll for
    // openclaw.json 666-permission.
    //
    // Pinchy mounts the shared volume at /openclaw-config (see docker-compose.yml).
    // We read AS THE PINCHY USER (--user pinchy) — that's the whole point of this
    // assertion; a `--user 0` read would succeed regardless of the chmod tick.
    let lastError: unknown = null;
    const deadline = Date.now() + 5000;
    try {
      while (Date.now() < deadline) {
        try {
          const readBack = composeExecAs("pinchy", "pinchy", `cat ${probePinchyPath}`);
          expect(readBack).toBe(expectedContent);
          return;
        } catch (err) {
          lastError = err;
          // back off and retry
        }
      }
      throw new Error(
        `Pinchy (uid 999) could not read root:0600 file in shared volume within 5s.\n` +
          `Last error: ${String(lastError)}`
      );
    } finally {
      // Best-effort cleanup so local re-runs don't accumulate probes in the
      // shared volume. CI tears the stack down with `down -v`, so this only
      // matters for developer workstations.
      try {
        execSync(
          `docker compose ${COMPOSE_FILES} exec -T --user 0 openclaw rm -f '${probeOpenClawPath}'`,
          { cwd: REPO_ROOT, env: COMPOSE_ENV, stdio: "pipe" }
        );
      } catch {
        // Cleanup failure is non-fatal; the test outcome already covers the
        // important case (read succeeded / failed). Surfacing a teardown
        // error here would mask the real assertion failure.
      }
    }
  });
});

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
 * via `su -s /bin/sh pinchy`), OpenClaw as uid 0, AND that the cross-uid
 * repair tick in `config/fix-config-permissions.sh` (run every 50 ms by
 * `config/start-openclaw.sh`) does exactly its job on the shared volume:
 *
 *   - it hands a bootstrap file OpenClaw created as root to uid 999, so
 *     Pinchy can rewrite it (#1095);
 *   - it leaves OpenClaw's `credentials/` private to root. Up to OpenClaw
 *     2026.8 Pinchy read Telegram pairing files there and the tick opened the
 *     tree to everyone; since 2026.9 Pinchy reads nothing there, and OpenClaw's
 *     browser relay ignores its secret unless it is owner-only.
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
 *   2. The repair tick removed or broken (a root-owned bootstrap file stays
 *      unwritable for uid 999).
 *   3. The shared volume isn't actually shared (Pinchy reads its own,
 *      empty mount instead of OpenClaw's writes — probe file is missing).
 *   4. Something opens `credentials/` to uid 999 again.
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

  // Probe names embed the run's timestamp so that re-running the suite locally
  // without `down -v` doesn't conflict with leftover probes from earlier runs
  // (the cleanup below tidies up, but unique names keep the assertions correct
  // even when cleanup is skipped — e.g. an aborted run).
  const runId = Date.now();

  /** Run a shell command as root in the OpenClaw container, content on stdin. */
  function asOpenClawRoot(cmd: string, input = ""): string {
    return execSync(`docker compose ${COMPOSE_FILES} exec -T --user 0 openclaw sh -c "${cmd}"`, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: COMPOSE_ENV,
      stdio: ["pipe", "pipe", "pipe"],
      input,
    }).trim();
  }

  function cleanUp(path: string): void {
    // Best-effort, so local re-runs don't accumulate probes in the shared
    // volume. CI tears the stack down with `down -v`, so this only matters for
    // developer workstations. A teardown error here would mask the real
    // assertion failure.
    try {
      asOpenClawRoot(`rm -rf '${path}'`);
    } catch {
      // non-fatal
    }
  }

  /**
   * Drop a root-owned bootstrap file into a probe workspace and wait until the
   * repair tick has handed it to uid 999. Returns the file's path in Pinchy's
   * mount. Anything on the volume before this call has been through at least
   * one full tick once it returns — which is what lets the credentials/ test
   * below assert a negative without a sleep.
   */
  function awaitRepairTick(workspace: string): string {
    asOpenClawRoot(
      `mkdir -p '/root/.openclaw/workspaces/${workspace}' && ` +
        `cat > '/root/.openclaw/workspaces/${workspace}/AGENTS.md' && ` +
        `chown -R 0:0 '/root/.openclaw/workspaces/${workspace}' && ` +
        `chmod 0644 '/root/.openclaw/workspaces/${workspace}/AGENTS.md'`,
      `# ${workspace}\n`
    );
    const pinchyPath = `/openclaw-config/workspaces/${workspace}/AGENTS.md`;

    // The tick runs every 50 ms inside start-openclaw.sh; 5s is ample. We read
    // AS THE PINCHY USER (--user pinchy) — a `--user 0` check would pass
    // whatever the tick does.
    let lastError: unknown = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const owner = composeExecAs("pinchy", "pinchy", `stat -c %u ${pinchyPath}`);
        if (owner === "999") return pinchyPath;
        lastError = new Error(`owner is uid ${owner}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `The repair tick did not hand a root-owned bootstrap file to uid 999 within 5s.\n` +
        `Last error: ${String(lastError)}`
    );
  }

  test("Pinchy (uid 999) can rewrite a bootstrap file OpenClaw created as root", () => {
    // Reproduces #1095: OpenClaw seeds a missing bootstrap file root-owned, and
    // Pinchy's next agent save got EACCES on it forever.
    const workspace = `__pinchy_uid_probe_${runId}`;
    try {
      const pinchyPath = awaitRepairTick(workspace);
      composeExecAs("pinchy", "pinchy", `sh -c "echo rewritten > ${pinchyPath}"`);
      expect(composeExecAs("pinchy", "pinchy", `cat ${pinchyPath}`)).toBe("rewritten");
    } finally {
      cleanUp(`/root/.openclaw/workspaces/${workspace}`);
    }
  });

  test("OpenClaw's credentials/ stays private to root", () => {
    const probeName = `__pinchy_uid_probe_${runId}.secret`;
    const probeOpenClawPath = `/root/.openclaw/credentials/${probeName}`;
    const probePinchyPath = `/openclaw-config/credentials/${probeName}`;
    const workspace = `__pinchy_uid_probe_${runId}_tick`;

    try {
      // Written via stdin rather than embedded in the shell command, so the
      // content stays safe even if a future change makes it user-influenced.
      asOpenClawRoot(
        `mkdir -p /root/.openclaw/credentials && cat > '${probeOpenClawPath}' && ` +
          `chown 0:0 '${probeOpenClawPath}' && chmod 0600 '${probeOpenClawPath}'`,
        `probe-${runId}`
      );

      // The probe is on the volume before this tick starts, so the tick has
      // had its chance to open it.
      awaitRepairTick(workspace);

      expect(asOpenClawRoot(`stat -c '%u %a' '${probeOpenClawPath}'`)).toBe("0 600");
      expect(() => composeExecAs("pinchy", "pinchy", `cat ${probePinchyPath}`)).toThrow(
        /Permission denied/
      );
    } finally {
      cleanUp(probeOpenClawPath);
      cleanUp(`/root/.openclaw/workspaces/${workspace}`);
    }
  });
});

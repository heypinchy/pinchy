/**
 * Hot-reload secrets-owner race regression test (issue #200).
 *
 * Bug on staging during v0.5.0 click-through:
 *   POST /api/agents → Pinchy writes openclaw.json + secrets.json →
 *   OpenClaw inotify triggers a reload → reload re-resolves secret
 *   providers → finds /openclaw-secrets/secrets.json owned by uid 999
 *   (Pinchy) → rejects with `SECRETS_RELOADER_DEGRADED: must be owned
 *   by the current user (uid=0)` → new agents.list silently dropped
 *   → user sees `unknown agent id "<uuid>"` when chatting.
 *
 * Fix: chown the secrets file in the same 0.2 s tick that already
 * chmods openclaw.json + credentials/, so the window between Pinchy's
 * write (uid 999) and OpenClaw's reload pickup never exposes the bad
 * owner. See `config/start-openclaw.sh:fix_config_permissions`.
 *
 * What this test reproduces directly:
 *   1. Force `secrets.json` to uid 999 (simulating Pinchy's atomic
 *      tmp+rename which always lands as uid 999).
 *   2. Touch `openclaw.json` to trigger inotify-driven reload.
 *   3. Within ~1 s, the chmod loop must restore root:root ownership.
 *      OpenClaw's reload must NOT log SECRETS_RELOADER_DEGRADED.
 *
 * This is a server-side, deterministic test of the race window —
 * does not depend on any per-agent auth-profile mechanics, the LLM
 * mock, or the chat UI.
 *
 * Why this lives in the telegram E2E suite:
 *   The suite already runs against `docker-compose.e2e.yml` which
 *   uses the production Dockerfile.pinchy (uid 999 demotion). That's
 *   the only place the owner mismatch can manifest.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";
import { waitForOpenClawConnected, waitForPinchy, seedSetup } from "./helpers";

const COMPOSE_FILES = "-f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.test.yml";
// Compose files live at the repo root; the test runner cwd is packages/web.
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function inOpenClaw(cmd: string): string {
  return execSync(`docker compose ${COMPOSE_FILES} exec -T openclaw sh -c "${cmd}"`, {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    // PINCHY_VERSION is required by docker-compose.yml's image: line; the
    // value doesn't matter for `exec` (it just looks up the running
    // container by service name), so any non-empty string works.
    env: { ...process.env, PINCHY_VERSION: process.env.PINCHY_VERSION || "local" },
  }).trim();
}

function getSecretsOwner(): string {
  return inOpenClaw("stat -c '%u:%g' /openclaw-secrets/secrets.json 2>/dev/null || echo 'missing'");
}

test.describe("Secrets owner race (#200)", () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180000);
    await waitForPinchy();
    await seedSetup();
    await waitForOpenClawConnected(120000);
  });

  test("secrets.json never lingers as uid 999 long enough for a reload to fail", async () => {
    test.setTimeout(60000);

    // Sanity: secrets file must exist (Pinchy writes it during seedSetup).
    const initialOwner = getSecretsOwner();
    expect(initialOwner).not.toBe("missing");

    // Force the bad owner state. This simulates Pinchy's atomic
    // writeSecretsFile() which always lands the file as uid 999 after
    // renameSync — that's the moment the bug bites.
    inOpenClaw("chown 999:999 /openclaw-secrets/secrets.json");
    expect(getSecretsOwner()).toBe("999:999");

    // The fast-tick chmod loop runs every 200 ms. Within ~1 s it must
    // have restored root:root. Poll up to 3 s for safety margin.
    let owner = "999:999";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      owner = getSecretsOwner();
      if (owner === "0:0") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(owner).toBe("0:0");
  });
});

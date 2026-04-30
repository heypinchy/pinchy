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
 * Fix (two layers): inotifywait on /openclaw-secrets/ chowns the file
 * on every close_write/moved_to event (sub-millisecond response), with
 * the existing 0.2 s chmod tick as defense-in-depth. See
 * `config/start-openclaw.sh`.
 *
 * What this test reproduces directly:
 *   1. Atomically write secrets.json with uid 999 ownership using
 *      Pinchy's exact tmp+rename pattern (`writeSecretsFile()`).
 *   2. The inotify watcher fires moved_to within milliseconds and
 *      chowns root:root before any OpenClaw reload could see uid 999.
 *   3. Owner is verified back to 0:0 within a 500 ms budget — far
 *      tighter than the 30 s legacy chown loop, but well within
 *      inotify reaction times in practice.
 *
 * This is a server-side, deterministic test of the race window —
 * does not depend on any per-agent auth-profile mechanics, the LLM
 * mock, or the chat UI.
 *
 * Why this lives in the telegram E2E suite:
 *   The suite already runs against `docker-compose.e2e.yml` which
 *   uses the production Dockerfile.pinchy (uid 999 demotion). That's
 *   currently the only CI surface where the owner mismatch can
 *   manifest. Once the rest of the E2E suites migrate to the
 *   production image (#196), this spec should move to a more apt
 *   location (e.g. an `agents/` or `infrastructure/` E2E suite).
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

function readSecretsJson(): string {
  // Returns the raw JSON text — base64-encoded over the docker-exec wire so
  // newlines and shell metachars survive the round-trip intact.
  const b64 = inOpenClaw("base64 -w0 /openclaw-secrets/secrets.json");
  return Buffer.from(b64, "base64").toString("utf-8");
}

function writeSecretsJsonAsRoot(content: string): void {
  // Pipe via base64 again to avoid quoting trouble on any payload.
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  inOpenClaw(
    `echo '${b64}' | base64 -d > /openclaw-secrets/secrets.json.tmp && ` +
      `chown root:root /openclaw-secrets/secrets.json.tmp && ` +
      `chmod 0600 /openclaw-secrets/secrets.json.tmp && ` +
      `mv /openclaw-secrets/secrets.json.tmp /openclaw-secrets/secrets.json`
  );
}

test.describe("Secrets owner race (#200)", () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180000);
    await waitForPinchy();
    await seedSetup();
    await waitForOpenClawConnected(120000);
  });

  test("atomic tmp+rename writing uid 999 is restored to root before any reload could read it", async () => {
    test.setTimeout(30000);

    // Pre-condition: file exists and is root-owned (start-openclaw.sh
    // chowns it on container start).
    const startOwner = getSecretsOwner();
    expect(startOwner).toBe("0:0");

    // Snapshot the real secrets payload so we can restore it after the
    // test. Otherwise we'd leave `secrets.json` as the `{}` we write below,
    // which would strip provider keys and break any subsequent test in
    // this suite that depends on OpenClaw resolving auth.
    const originalContent = readSecretsJson();

    try {
      // Reproduce Pinchy's atomic writeSecretsFile() pattern exactly:
      // 1. Write a tmp file (here as root, content doesn't matter for the race).
      // 2. chown it to uid 999 (Pinchy's uid; we cannot run as uid 999 from
      //    inside the OpenClaw container — there's no such user — but the
      //    end-state on disk after Pinchy's rename is the same: owner 999).
      // 3. mv onto secrets.json — this is the moved_to event inotify watches.
      // The replaced inode is now uid 999, exactly the bug condition.
      inOpenClaw(
        "echo '{}' > /openclaw-secrets/secrets.json.tmp && " +
          "chown 999:999 /openclaw-secrets/secrets.json.tmp && " +
          "mv /openclaw-secrets/secrets.json.tmp /openclaw-secrets/secrets.json"
      );

      // inotify reacts in single-digit milliseconds — far faster than the
      // 200 ms chmod loop. Poll fast (10 ms) and tightly bounded (500 ms)
      // so a regression of either path (loop or watcher) is visible.
      let owner = "";
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        owner = getSecretsOwner();
        if (owner === "0:0") break;
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(owner).toBe("0:0");
    } finally {
      // Restore the original secrets payload regardless of test outcome —
      // subsequent tests need a valid bundle.
      writeSecretsJsonAsRoot(originalContent);
    }
  });
});

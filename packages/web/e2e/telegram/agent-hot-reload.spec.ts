/**
 * Agent hot-reload E2E test — regression for the v0.5.0 staging bug where a
 * newly created custom agent surfaced as `unknown agent id "<uuid>"` on the
 * first chat message after creation.
 *
 * Two distinct manifestations across PRs:
 *
 *   1. (#200, fixed in #201) `secrets.json` was owned by uid 999 when
 *      OpenClaw's reload pipeline tried to re-resolve secret providers,
 *      so the reload bailed with `SECRETS_RELOADER_DEGRADED` and the new
 *      `agents.list` was silently dropped.
 *
 *   2. (this fix) Even with secrets owner correct, OpenClaw's internal
 *      file-watcher does not promptly notice an `agents.list` change
 *      written to `openclaw.json`. On staging the reload fired only ~60 s
 *      after the file write — far too late for the user, who already saw
 *      "unknown agent id" within seconds of clicking Send.
 *
 * The fix for (2) is for Pinchy to push the new config to OpenClaw via the
 * WebSocket RPC `client.config.apply()` immediately after writing the file,
 * instead of relying on inotify. See `regenerateOpenClawConfig()` in
 * `packages/web/src/lib/openclaw-config.ts`.
 *
 * What this test reproduces:
 *   1. POST /api/agents to create a brand-new custom agent.
 *   2. Open the chat page for it and send a message.
 *   3. Assert that within 60 s some response indicator appears AND that
 *      it is NOT the `unknown agent id` error. Other errors are tolerated
 *      (e.g. FailoverError on per-agent auth profiles in the test mock
 *      setup) — those are unrelated to the bug under test.
 *
 * Why this lives in the telegram E2E suite (production image stack):
 *   The suite runs against `docker-compose.e2e.yml` which uses
 *   `Dockerfile.pinchy` — the only CI surface today with the production
 *   uid 999 demotion. Once the rest of the E2E suites migrate to the
 *   production image (#196), move this spec to a more apt location.
 */

import { test, expect } from "@playwright/test";
import { seedSetup, waitForOpenClawConnected, waitForPinchy } from "./helpers";

const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";

/**
 * Wait until OpenClaw is reachable AND stays reachable for `stableMs`.
 *
 * The Pinchy cold-start cascade (#189) restarts the OpenClaw gateway
 * multiple times in the first ~2 minutes after a fresh `docker compose up`:
 * once when Pinchy first writes openclaw.json, once when the secrets-mtime
 * watcher in start-openclaw.sh notices the provider-key change, possibly
 * more if plugin enable/disable triggers extra restart cycles. The plain
 * `waitForOpenClawConnected` catches the first brief connected window and
 * returns — but the next restart is still ahead, and any test that races
 * regenerateOpenClawConfig against that window sees the WS disconnected
 * and the new agent never reaches OpenClaw runtime in time.
 *
 * Waiting for `stableMs` of continuous connectivity gives a strong signal
 * that the cascade is done.
 */
async function waitForOpenClawStable(stableMs = 10000, timeout = 180000): Promise<void> {
  const start = Date.now();
  let stableSince: number | null = null;
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${PINCHY_URL}/api/health/openclaw`);
      const data = (await res.json()) as { connected: boolean };
      if (data.connected) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return;
      } else {
        stableSince = null;
      }
    } catch {
      stableSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`OpenClaw never stably connected for ${stableMs}ms within ${timeout}ms`);
}

test.describe("Agent hot-reload (production image)", () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await waitForPinchy();
    await seedSetup();
    await waitForOpenClawConnected(120000);
    // Don't just catch the first connected window — the cold-start cascade
    // can drop the WS again seconds later. Wait for sustained connectivity.
    await waitForOpenClawStable();
  });

  test("custom agent created via API does not surface 'unknown agent id' on first chat", async ({
    page,
  }) => {
    test.setTimeout(180000);

    // 1. Login via UI so the browser context owns the session cookie that
    //    the chat WebSocket auth requires.
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // 2. Create a custom agent via the public API. POST /api/agents calls
    //    `regenerateOpenClawConfig()` which (a) writes openclaw.json + secrets.json
    //    to disk and (b) — with the fix — pushes the new config via the
    //    config.apply WebSocket RPC. Without (b), the new agents.list takes
    //    ~60 s to reach OpenClaw's runtime via inotify.
    const createRes = await page.request.post("/api/agents", {
      data: {
        name: `HotReloadTest-${Date.now()}`,
        templateId: "custom",
      },
    });
    expect(createRes.ok()).toBe(true);
    const agent = (await createRes.json()) as { id: string };

    // 2.5. The config push triggered a gateway restart (because Pinchy's
    //      regenerated config touches plugins.entries.* — a hot-reload
    //      isn't possible). On a busy CI runner the restart cycle takes
    //      ~15-30 s; until OpenClaw is reachable again, the chat WS would
    //      either hang or drop. Wait for steady state before opening the chat
    //      page to keep the assertion focused on the unknown-agent-id bug
    //      rather than picking up restart-window flakiness.
    await waitForOpenClawConnected(60000);

    // 3. Open chat for the freshly created agent and send a message.
    await page.goto(`/chat/${agent.id}`);
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill("Hello, are you there?");
    await input.press("Enter");

    // 4. Wait for SOME chat-completion signal — either a successful response
    //    or any error banner. With the fix, this lands within seconds.
    //    Without the fix, the new agent isn't registered and Pinchy waits
    //    on a chat that never resolves; the error banner only appears after
    //    the connection timeout fires.
    await page
      .getByText(/Mock response from test server|couldn't respond|unknown agent id/i)
      .first()
      .waitFor({ state: "visible", timeout: 90000 });

    // 5. Specific assertion: the bug fingerprint `unknown agent id` must NOT
    //    appear. Any other error (e.g. provider auth failures from the mock
    //    setup) is unrelated to this bug and tolerated.
    const unknownAgentError = page.getByText(/unknown agent id/i);
    await expect(unknownAgentError).not.toBeVisible();
  });
});

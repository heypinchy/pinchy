/**
 * E2E regression for Issue #476 Gap 1: disconnecting a Telegram bot must
 * promptly stop its poller, not leave it running for an indeterminate time
 * while OpenClaw's inotify watcher eventually notices the config change.
 *
 * Background: `updateTelegramChannelConfig()` (packages/web/src/lib/openclaw-
 * config/targeted.ts), shared by the per-agent `DELETE
 * /api/agents/[agentId]/channels/telegram` route and the org-wide `DELETE
 * /api/settings/telegram/all` route, only wrote the config file and called
 * `restartState.notifyRestart()` for UI purposes — the actual OpenClaw reload
 * relied entirely on the container's file-watcher noticing the write. That
 * left a latency gap during which a disconnected bot's channel worker could
 * keep polling `getUpdates` against Telegram, which is the root cause of the
 * cross-instance getUpdates 409 flap that originally motivated #476: a stale
 * poller from a disconnected/removed bot instance kept fighting a fresh one
 * for the same long-poll slot.
 *
 * This spec measures the gap directly: connect a bot, confirm it's actively
 * polling the mock, disconnect it via the per-agent route, and assert the
 * poller goes quiet (drops out of the mock's `activePollingTokens`, a
 * freshness-based signal distinct from the ever-growing `pollingTokens` set)
 * within a bounded window.
 */

import { test, expect } from "@playwright/test";
import {
  login,
  getAgentId,
  connectBot,
  disconnectBot,
  resetMockTelegram,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  waitForTelegramPolling,
  waitForBotPolling,
  waitForBotStoppedPolling,
  seedSetup,
  pinchyPost,
  pinchyGet,
} from "./helpers";
import { waitForAgentDispatchable } from "../shared/dispatch-probe";

// Smithers' own bot token — same literal as agent-create-no-restart.spec.ts so
// a prior suite's connectBot(Smithers, ...) in the same run is a no-op here
// (targeted-write dedup: "same token already configured" → file write skipped,
// nothing destabilizes an already-live poller). Smithers must have a bot
// connected before a NON-personal agent (our second agent below) is allowed
// to connect one (`hasMainTelegramBot()` guard in the per-agent route).
const MAIN_BOT_TOKEN = "123456:ABC-test-token-for-e2e";

// Distinct token for the throwaway second agent this spec disconnects. Kept
// separate from MAIN_BOT_TOKEN and telegram-flow.spec.ts's SECOND_BOT_TOKEN
// so this spec's connect/disconnect cycle doesn't collide with other specs'
// bot state when the suite runs as a whole.
const BOT_TOKEN = "555444:GHI-disconnect-stops-poller-e2e";

test.describe.serial("Telegram disconnect stops the poller (#476 Gap 1)", () => {
  let agentId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000); // 5 min — services can be slow in CI
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    await waitForOpenClawConnected(120000);
    await login();

    // Ensure Smithers (the main bot) is configured — required before a
    // non-personal agent's bot can connect at all (hasMainTelegramBot()).
    const smithersId = await getAgentId();
    await connectBot(smithersId, MAIN_BOT_TOKEN);
    await waitForTelegramPolling();

    // Smithers is Pinchy's main bot; the per-agent disconnect route refuses
    // to remove it individually ("Use 'Remove Telegram for everyone'"). Use a
    // SECOND, non-personal agent instead, same pattern as the Multi-Bot suite
    // in telegram-flow.spec.ts.
    //
    // Created via the real POST /api/agents route (NOT a raw DB insert like
    // helpers.ts's createAgent()) with a unique per-run name, and confirmed
    // dispatchable before connecting a bot. This matters specifically BECAUSE
    // of the #476 Gap 1 fix: updateTelegramChannelConfig now routes through
    // config.apply when a WS client is connected, and OpenClaw's config.apply
    // RPC validates `bindings[].agentId` against the runtime's already-loaded
    // `agents.list` — unlike the old file+inotify path, which never validated
    // synchronously. A raw-SQL-inserted (or previously-created-but-never-
    // dispatchable) agent is absent from `agents.list`, so config.apply
    // legitimately rejects the binding ("Unknown agent id ... not in
    // agents.list") and the bot never starts polling. Going through the real
    // creation route (which regenerates config and lands the agent in OC's
    // runtime) avoids that class of failure — the same reason
    // agent-create-no-restart.spec.ts uses waitForAgentDispatchable before
    // dispatching to a freshly created agent. A fresh name per run (rather
    // than reusing a fixed name via getAgentByName) sidesteps a stale
    // never-dispatchable row surviving from an earlier interrupted run.
    const createRes = await pinchyPost("/api/agents", {
      // Name field is capped at 30 chars — keep the prefix short.
      name: `Gap1Poller-${Date.now()}`,
      templateId: "custom",
    });
    const body = await createRes.text();
    if (createRes.status >= 300) {
      throw new Error(`create Gap1 Poller Test Bot failed: ${createRes.status} ${body}`);
    }
    const agent = JSON.parse(body) as { id: string; name: string };
    agentId = agent.id;

    await waitForAgentDispatchable(
      (id) => pinchyGet(`/api/health/openclaw?agentId=${id}`),
      agentId,
      { deadlineMs: 90_000 }
    );
  });

  test.beforeEach(async () => {
    await resetMockTelegram();
  });

  test("poller stops within 15s of disconnecting the bot", async () => {
    const result = await connectBot(agentId, BOT_TOKEN);
    expect(result.botUsername).toBeTruthy();
    await waitForBotPolling(BOT_TOKEN);

    await disconnectBot(agentId);

    // The critical assertion: the poller must go quiet promptly, not linger
    // until an eventual, unbounded inotify-triggered restart catches up.
    // waitForBotStoppedPolling throws (failing the test) on timeout.
    await waitForBotStoppedPolling(BOT_TOKEN, 15000);
  });
});

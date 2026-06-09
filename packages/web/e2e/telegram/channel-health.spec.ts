/**
 * E2E for the channel-health watchdog (A-1/A-2/A-4).
 *
 * Reproduces the production incident — a Telegram bot token polled by a second
 * deployment returns HTTP 409 "Conflict: terminated by other getUpdates
 * request", driving OpenClaw's channel worker into a silent crash/restart loop
 * — against a PROTOCOL-REAL OpenClaw (not a mock of OC). Asserts Pinchy now
 * detects it and writes the audit rows that were completely absent during the
 * real incident: channel.degraded → channel.polling_failed → channel.recovered.
 *
 * Runs with CHANNEL_HEALTH_INTERVAL_MS=3000 (docker-compose.test.yml) so the
 * transitions are observed in seconds.
 */
import { test, expect } from "@playwright/test";
import {
  seedSetup,
  login,
  getAgentId,
  getAgentByName,
  createAgent,
  connectBot,
  disconnectBot,
  waitForBotPolling,
  waitForPinchy,
  waitForOpenClawConnected,
  setMockConflict409,
  pollAuditForChannelEvent,
  resetMockTelegram,
} from "./helpers";

// Distinct bot ids (8101… vs 8102…) so the within-deployment duplicate-token
// guard is satisfied and these tokens don't collide with other telegram specs.
const MAIN_BOT_TOKEN = "8101000001:AAEchannelHealthMainBot0000000000000";
const CONFLICT_BOT_TOKEN = "8102000002:AAEchannelHealthConflictBot00000000";

test.describe("channel-health watchdog", () => {
  test.beforeAll(async () => {
    await waitForPinchy();
    await seedSetup();
    await waitForOpenClawConnected();
    await login();
  });

  // Self-contained: clear the conflict toggle + mock state even if an assertion
  // fails mid-test, so a future spec-ordering change can't inherit leaked state.
  test.afterAll(async () => {
    try {
      await setMockConflict409(CONFLICT_BOT_TOKEN, false);
      await resetMockTelegram();
    } catch {
      // best-effort cleanup
    }
  });

  test("audits a telegram bot's getUpdates-409 conflict: degraded → polling_failed → recovered", async () => {
    // Smithers (personal) is the main bot — a prerequisite for connecting a
    // bot to any non-personal agent.
    const smithers = await getAgentId();
    await connectBot(smithers, MAIN_BOT_TOKEN);
    await waitForBotPolling(MAIN_BOT_TOKEN);

    // A dedicated non-personal agent with its own bot — mirrors the incident,
    // where a SHARED agent's bot (not the personal one) was duplicated across
    // environments.
    const existing = await getAgentByName("ChannelHealthBot");
    const agent = existing ?? (await createAgent("ChannelHealthBot"));
    await connectBot(agent.id, CONFLICT_BOT_TOKEN);
    await waitForBotPolling(CONFLICT_BOT_TOKEN);

    // Second deployment polls the same token → Telegram 409 for THIS bot only.
    await setMockConflict409(CONFLICT_BOT_TOKEN, true);

    const degraded = await pollAuditForChannelEvent("channel.degraded", agent.id);
    expect(degraded.outcome).toBe("failure");
    expect(degraded.resource).toBe(`agent:${agent.id}`);
    expect(degraded.detail.channel).toBe("telegram");
    expect(String(degraded.detail.lastError)).toContain("terminated by other getUpdates request");
    // The agent name is snapshotted; no PII (email) in the detail.
    expect(JSON.stringify(degraded.detail)).not.toContain("@");

    // Sustained failure escalates to a terminal audit.
    const failed = await pollAuditForChannelEvent("channel.polling_failed", agent.id);
    expect(failed.outcome).toBe("failure");

    // Stop the conflict → OpenClaw's worker reconnects → channel.recovered.
    await setMockConflict409(CONFLICT_BOT_TOKEN, false);
    const recovered = await pollAuditForChannelEvent("channel.recovered", agent.id);
    expect(recovered.outcome).toBe("success");

    await disconnectBot(agent.id);
    await disconnectBot(smithers);
  });
});

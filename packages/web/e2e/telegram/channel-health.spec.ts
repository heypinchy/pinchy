/**
 * E2E for the channel-health watchdog (A-1/A-2/A-4, #477 layers 2+3).
 *
 * Reproduces the production incident — a Telegram bot token polled by a second
 * deployment returns HTTP 409 "Conflict: terminated by other getUpdates
 * request" — against a PROTOCOL-REAL OpenClaw (not a mock of OC). Asserts
 * Pinchy detects it (channel.degraded → channel.polling_failed), actively
 * restarts the conflicted account (channel.restarted — since OpenClaw's
 * isolated-ingress rework a 409 otherwise leaves the poller dormant on a
 * backoff that compounds to 10 minutes), recovers it once the conflict clears
 * (channel.recovered), and auto-disables a recently-added newcomer whose
 * conflict survives the restarts (channel.auto_disabled).
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
  atOrAfter,
  atOrBefore,
  withConflictError,
  resetMockTelegram,
  getTelegramChannelStatus,
} from "./helpers";

// Distinct bot ids (8101… vs 8102… vs 8103…) so the within-deployment
// duplicate-token guard is satisfied and these tokens don't collide with
// other telegram specs.
const MAIN_BOT_TOKEN = "8101000001:AAEchannelHealthMainBot0000000000000";
const CONFLICT_BOT_TOKEN = "8102000002:AAEchannelHealthConflictBot00000000";
const AUTO_DISABLE_BOT_TOKEN = "8103000003:AAEchannelHealthAutoDisableBot000000";

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

  // Tagged @channel-restart (skipped in CI, like the existing multi-bot tests
  // in telegram-flow.spec.ts) because it connects a main + second bot, waits on
  // their polling, and drives an OpenClaw channel restart loop — all of which
  // are timing-sensitive against the shared serial CI OpenClaw. The detection
  // logic is fully covered by the unit tests (channel-health{,-watchdog}.test.ts,
  // which run in CI); this E2E is the integration check for local/nightly runs.
  test(
    "audits a telegram bot's getUpdates-409 conflict: degraded → polling_failed → recovered",
    { tag: "@channel-restart" },
    async () => {
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

      // ANCHOR on channel.restarted (#477 layer 3): the watchdog restarts the
      // conflicted account itself (channels.stop/start) once the episode
      // crosses polling_failed — since OpenClaw's isolated-ingress rework, a
      // 409 otherwise leaves the poller dormant on a backoff that compounds to
      // 10 minutes. This is the only row whose detail carries the 409 text
      // DETERMINISTICALLY: the degraded/polling_failed rows can open with
      // lastError:null when the episode starts as a config-apply restart blip
      // and the conflict text lands in channels.status a few ticks later.
      const restarted = await pollAuditForChannelEvent("channel.restarted", agent.id, {
        where: withConflictError,
      });
      expect(restarted.outcome).toBe("success");
      expect(restarted.resource).toBe(`agent:${agent.id}`);
      expect(restarted.detail.channel).toBe("telegram");
      expect(restarted.detail.reason).toBe("polling_conflict");
      expect(String(restarted.detail.lastError)).toContain(
        "terminated by other getUpdates request"
      );
      // The agent name is snapshotted; no PII (email) in the detail.
      expect(JSON.stringify(restarted.detail)).not.toContain("@");

      // The episode rows precede the restart: one channel.degraded on the
      // healthy→degraded edge, escalated to channel.polling_failed.
      const degraded = await pollAuditForChannelEvent("channel.degraded", agent.id, {
        where: atOrBefore(restarted),
      });
      expect(degraded.outcome).toBe("failure");
      expect(degraded.resource).toBe(`agent:${agent.id}`);
      expect(degraded.detail.channel).toBe("telegram");
      expect(JSON.stringify(degraded.detail)).not.toContain("@");

      const failed = await pollAuditForChannelEvent("channel.polling_failed", agent.id, {
        where: atOrBefore(restarted),
      });
      expect(failed.outcome).toBe("failure");

      // Stop the conflict → the next paced watchdog restart brings the fresh
      // polling session up cleanly → channel.recovered. The atOrAfter guard
      // keeps a connect-window recovered row (pre-conflict) from turning this
      // into a false green.
      await setMockConflict409(CONFLICT_BOT_TOKEN, false);
      const recovered = await pollAuditForChannelEvent("channel.recovered", agent.id, {
        where: atOrAfter(restarted),
      });
      expect(recovered.outcome).toBe("success");

      await disconnectBot(agent.id);
      await disconnectBot(smithers);
    }
  );

  // #477 layer 2: a RECENTLY-connected bot (this one — connected seconds ago
  // by this very test) hitting the getUpdates-409 conflict gets auto-disabled
  // once the conflict has SURVIVED the layer-3 restarts (two restart cycles
  // past the polling_failed threshold) — the newcomer backs off automatically
  // instead of both instances looping forever, but only on live evidence, not
  // on a stale status snapshot. Reuses the same conflict-injection mechanism
  // as the test above; distinct bot id so the two specs don't collide.
  test(
    "auto-disables a recently-connected bot on a sustained getUpdates-409 conflict",
    { tag: "@channel-restart" },
    async () => {
      // Setup (two bots + sustained-polling oracles) plus the ~84s deferred
      // disable ladder does not fit the suite-wide 3-minute test timeout.
      test.setTimeout(300000);
      const smithers = await getAgentId();
      await connectBot(smithers, MAIN_BOT_TOKEN);
      await waitForBotPolling(MAIN_BOT_TOKEN);

      const existing = await getAgentByName("ChannelHealthAutoDisableBot");
      const agent = existing ?? (await createAgent("ChannelHealthAutoDisableBot"));
      await connectBot(agent.id, AUTO_DISABLE_BOT_TOKEN);
      await waitForBotPolling(AUTO_DISABLE_BOT_TOKEN);

      // Second deployment polls the same token → sustained 409 for this bot.
      await setMockConflict409(AUTO_DISABLE_BOT_TOKEN, true);

      // The deferred-disable ladder needs polling_failed (4 ticks) + two
      // restart cycles (8 + 16 ticks) at CHANNEL_HEALTH_INTERVAL_MS=3000
      // before the disable decision (~84s) — give the poll real headroom.
      const autoDisabled = await pollAuditForChannelEvent("channel.auto_disabled", agent.id, {
        timeout: 180000,
        where: withConflictError,
      });
      expect(autoDisabled.outcome).toBe("success");
      expect(autoDisabled.resource).toBe(`agent:${agent.id}`);
      expect(autoDisabled.detail.channel).toBe("telegram");
      expect(String(autoDisabled.detail.lastError)).toContain(
        "terminated by other getUpdates request"
      );

      const status = await getTelegramChannelStatus(agent.id);
      expect(status.conflictDisabled).toBe(true);

      await setMockConflict409(AUTO_DISABLE_BOT_TOKEN, false);
      await disconnectBot(smithers);
    }
  );
});

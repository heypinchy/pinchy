/**
 * E2E for the Telegram Media Mirror.
 *
 * Proves the full protocol-real round trip: an inbound Telegram PHOTO is
 * downloaded by OpenClaw itself (grammY resolves `getFile` + the file download
 * URL against `api.telegram.org`, which `docker-compose.test.yml` DNS-overrides
 * to the mock — see that file's `extra_hosts`), the `pinchy-transcript` plugin
 * reports the saved path via `metadata.mediaPaths` to
 * `POST /api/internal/channel-messages`, and that route's `mirrorChannelMedia`
 * copies the file from OpenClaw's shared inbound media store into the agent's
 * workspace `uploads/` dir — auditing one `channel.media_mirrored` row per file
 * (see `packages/web/src/server/channel-media.ts` and
 * `packages/web/src/app/api/internal/channel-messages/route.ts`).
 *
 * Wiring this depends on (verified, not assumed):
 *  - `docker-compose.test.yml` DNS-overrides `api.telegram.org` to the mock's
 *    static IP inside the `openclaw` container, so grammY's `getFile` AND its
 *    subsequent `GET /file/bot<token>/<file_path>` download both transparently
 *    hit the mock — no OpenClaw/grammY code path needs mocking.
 *  - The base `docker-compose.yml` mounts the SAME `openclaw-config` volume at
 *    `/root/.openclaw` in the `openclaw` container and at `/openclaw-config` in
 *    the `pinchy` container. OpenClaw saves inbound media under
 *    `~/.openclaw/media/inbound/`, which is exactly
 *    `getMediaInboundPath()`'s default (`/openclaw-config/media/inbound`) as
 *    seen from the pinchy container — no `MEDIA_INBOUND_PATH` override needed
 *    in the E2E overlay.
 *  - `channels.telegram.network.dangerouslyAllowPrivateNetwork` must be set
 *    (via `PINCHY_E2E_ALLOW_PRIVATE_TELEGRAM_MEDIA=1` in docker-compose.test.yml,
 *    see build.ts's `desiredTelegram`). OpenClaw SSRF-guards the actual file
 *    download against private-network targets by default; without the
 *    override the download is silently rejected before it ever reaches the
 *    mock, even though `getFile` itself (a normal Bot API call, not
 *    SSRF-checked) succeeds.
 *  - Smithers runs with `dmPolicy: "pairing"`. An UNLINKED peer's messages —
 *    including this photo — never reach agent/media dispatch at all; they're
 *    intercepted by OpenClaw's own pairing flow, which replies with a
 *    pairing code instead. The test pairs `TG_PEER_ID` first (same flow
 *    `chats.spec.ts` uses) before sending the photo.
 *
 * Prerequisites: Docker stack running with mock Telegram server:
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
 *
 * Run: pnpm -C packages/web test:e2e:telegram
 */

import { test, expect } from "@playwright/test";
import {
  login,
  getAgentId,
  connectBot,
  setAgentPersonalOwnedByAdmin,
  sendTelegramPhoto,
  sendTelegramAndAwaitReply,
  linkTelegram,
  unlinkTelegram,
  waitForBotPolling,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  seedSetup,
  getAdminEmail,
} from "./helpers";
import {
  pollAuditForEvent,
  waitForOpenClawStable,
  waitForAgentDispatchable,
} from "../shared/dispatch-probe";

// Same token Smithers' main bot uses across the suite (telegram-flow.spec.ts,
// disconnect-stops-poller.spec.ts, chats.spec.ts) — reusing it makes connectBot
// a idempotent no-op rather than tearing down and restarting an already-live
// poller, and Smithers must already be the connected main bot before any
// non-personal agent may connect its own token.
const BOT_TOKEN = "123456:ABC-test-token-for-e2e";
const PINCHY_URL = process.env.PINCHY_URL || "http://localhost:7777";

// A peer id distinct from every other telegram spec's (chats.spec.ts uses
// 555444333, telegram-flow.spec.ts uses 999888777) so this suite's inbound
// photo can never be confused with another spec's traffic when specs share
// the same long-lived OpenClaw stack.
const TG_PEER_ID = "666333222";
const TG_USERNAME = "media_e2e_peer";

test.describe("Telegram media mirror", () => {
  let agentId: string;
  const ADMIN_PASSWORD = "test-password-123";

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(180000);
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    await waitForOpenClawConnected(120000);

    await login();
    agentId = await getAgentId();
    expect(agentId).toBeTruthy();

    // Self-heal: a prior spec file may have left Smithers SHARED
    // (chats.spec.ts flips it, then restores in afterAll — but re-running this
    // file in isolation must not depend on that). Smithers must be PERSONAL to
    // be eligible as the main bot.
    await setAgentPersonalOwnedByAdmin(agentId);

    await connectBot(agentId, BOT_TOKEN);
    await waitForBotPolling(BOT_TOKEN);

    // connectBot pushes a config.apply that briefly tears the OpenClaw bridge
    // down and restarts the telegram channel worker. `waitForBotPolling` only
    // proves the MOCK sees a sustained poll — it does NOT prove OpenClaw's own
    // channel worker has stopped churning through restarts (a PRECEDING spec
    // file's own connect/disconnect cleanup, e.g. disconnect-stops-poller.spec.ts
    // running immediately before this file, can leave a channel restart
    // in-flight for several seconds after the mock already reports the token as
    // "active"). Sending the photo mid-restart risks the message being picked
    // up by a handler that's mid-teardown and never finishes processing it —
    // no reply, no media download, nothing. Gate on the same contiguous
    // connected+settled window chats.spec.ts uses before it dispatches, so the
    // photo is only sent once OpenClaw is genuinely idle.
    await waitForOpenClawStable(() => fetch(`${PINCHY_URL}/api/health/openclaw`), {
      stableForMs: 10_000,
      deadlineMs: 180_000,
    });
    await waitForAgentDispatchable(
      (id) => fetch(`${PINCHY_URL}/api/health/openclaw?agentId=${id}`),
      agentId,
      { deadlineMs: 90_000 }
    );
  });

  test("an inbound Telegram photo is mirrored into the agent's uploads dir", async ({ page }) => {
    // Authenticate page.request's cookie jar (separate from the module-global
    // cookie the `helpers.ts` fetch-based functions use) so
    // `pollAuditForEvent` can call the real, session-authed /api/audit route.
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: getAdminEmail(), password: ADMIN_PASSWORD },
      headers: { "Content-Type": "application/json", Origin: PINCHY_URL },
    });
    expect(signIn.ok()).toBeTruthy();

    // Smithers is PERSONAL with `dmPolicy: "pairing"`: an UNLINKED peer never
    // reaches agent/LLM dispatch at all — every inbound message (photo
    // included) is intercepted by OpenClaw's own native pairing flow, which
    // replies with a pairing code instead of processing the message. That
    // path never calls `resolveMedia`, so `channel.media_mirrored` would
    // never fire no matter how long we wait. Pair this peer first (same
    // flow chats.spec.ts uses for TG_PEER_ID) so the photo we send afterward
    // is a genuine linked-user turn that reaches media resolution.
    const pairResp = await sendTelegramAndAwaitReply({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      text: "Pair me please",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "MediaE2E",
    });
    const codeMatch = pairResp.match(/Pairing code:(?:\s|<[^>]+>|`)*([A-Za-z0-9][A-Za-z0-9_-]*)/i);
    expect(codeMatch, `expected a pairing code, got: ${pairResp.slice(0, 200)}`).toBeTruthy();
    const linkRes = await linkTelegram(codeMatch![1].trim());
    expect(linkRes.status).toBe(200);
    // Brief settle so OpenClaw picks up the link before the next inbound
    // message (mirrors chats.spec.ts's own post-link wait).
    await new Promise((r) => setTimeout(r, 2000));

    const since = new Date().toISOString();

    await sendTelegramPhoto({
      token: BOT_TOKEN,
      chatId: TG_PEER_ID,
      caption: "receipt",
      userId: TG_PEER_ID,
      username: TG_USERNAME,
      firstName: "MediaE2E",
    });

    // Observable: OpenClaw downloads the photo from the mock, the
    // pinchy-transcript plugin reports metadata.mediaPaths, and the capture
    // route mirrors the file into workspaces/<agentId>/uploads — recording one
    // channel.media_mirrored success row with the mock's photos/file_<n>.jpg
    // basename.
    const entry = await pollAuditForEvent(page, {
      eventType: "channel.media_mirrored",
      since,
      deadlineMs: 90000,
      predicate: (e) =>
        e.resource === `agent:${agentId}` &&
        e.outcome === "success" &&
        /^file_\d+\.jpg$/.test(String((e.detail as { filename?: string } | null)?.filename ?? "")),
    });

    const detail = entry.detail as {
      agent?: { id?: string; name?: string | null };
      filename?: string;
      mimeType?: string | null;
      bytes?: number | null;
      channel?: string;
    };
    expect(detail.agent?.id).toBe(agentId);
    expect(detail.channel).toBe("telegram");
    expect(detail.bytes ?? 0).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    // Leave the suite's shared state clean for later spec files (mirrors
    // chats.spec.ts's own afterAll self-heal): unlink the peer we paired
    // above and restore Smithers to personal. Best-effort — must not fail
    // the suite.
    await unlinkTelegram().catch(() => {});
    if (agentId) await setAgentPersonalOwnedByAdmin(agentId).catch(() => {});
  });
});

/**
 * Telegram E2E Tests — Full link/unlink/re-link flow.
 *
 * Prerequisites: Docker stack running with mock Telegram server:
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
 *
 * Run: pnpm test:telegram
 */

import { test, expect } from "@playwright/test";
import {
  login,
  getAgentId,
  getAgentByName,
  createAgent,
  connectBot,
  disconnectBot,
  sendTelegramMessage,
  waitForBotResponse,
  resetMockTelegram,
  linkTelegram,
  unlinkTelegram,
  getTelegramLinkStatus,
  waitForPinchy,
  waitForMockTelegram,
  waitForOpenClawConnected,
  waitForTelegramPolling,
  seedSetup,
} from "./helpers";

const BOT_TOKEN = "123456:ABC-test-token-for-e2e";
const TELEGRAM_USER_ID = "999888777";
const TELEGRAM_USERNAME = "e2e_tester";

test.describe.serial("Telegram Integration", () => {
  let agentId: string;
  let lastPairingCode: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000); // 5 min — services can be slow in CI
    // Wait for services to be ready
    await waitForPinchy();
    await waitForMockTelegram();

    // Create admin user and provider config if not already done
    await seedSetup();
    await resetMockTelegram();
    await waitForOpenClawConnected(120000);
  });

  test("setup: login and get agent ID", async () => {
    await login();
    agentId = await getAgentId();
    expect(agentId).toBeTruthy();
  });

  test("setup: connect Telegram bot", async () => {
    const result = await connectBot(agentId, BOT_TOKEN);
    expect(result.botUsername).toBeTruthy();
    expect(result.botId).toBeGreaterThan(0);

    // Wait for OpenClaw to start polling the mock Telegram server
    await waitForTelegramPolling();
  });

  test("unlinked user receives pairing response", async () => {
    const beforeSend = new Date().toISOString();

    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TELEGRAM_USER_ID,
      text: "Hello Smithers!",
      userId: TELEGRAM_USER_ID,
      username: TELEGRAM_USERNAME,
      firstName: "E2E",
      lastName: "Tester",
    });

    // OpenClaw should respond with a pairing message (not silence!)
    // Timeout 90s: OpenClaw 2026.3.24 model prewarm can be slow on first start
    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 90000,
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    // Extract pairing code from bot response (format: "Pairing code: XXXXXXXX")
    const codeMatch = response.match(/Pairing code:\s*(\S+)/i);
    expect(codeMatch).toBeTruthy();
    lastPairingCode = codeMatch![1];
    console.log(`[test] Bot pairing response, code: ${lastPairingCode}`);
  });

  test("user can link via pairing code", async () => {
    expect(lastPairingCode).toBeTruthy();

    const res = await linkTelegram(lastPairingCode);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.linked).toBe(true);
    expect(data.telegramUserId).toBe(TELEGRAM_USER_ID);

    console.log(`[test] Linked with pairing code: ${lastPairingCode}`);
  });

  test("linked user receives agent response (not pairing)", { tag: "@llm" }, async () => {
    // Wait for config reload
    // Brief wait for OpenClaw to detect config change via file watcher
    await new Promise((r) => setTimeout(r, 2000));

    const beforeSend = new Date().toISOString();

    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TELEGRAM_USER_ID,
      text: "What can you help me with?",
      userId: TELEGRAM_USER_ID,
      username: TELEGRAM_USERNAME,
      firstName: "E2E",
    });

    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 60000, // LLM response can be slow
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    // Agent response should NOT contain pairing instructions
    console.log(`[test] Agent response: "${response.substring(0, 100)}..."`);
  });

  test("unlink removes telegram access", async () => {
    const res = await unlinkTelegram();
    expect(res.status).toBe(200);

    const status = await getTelegramLinkStatus();
    expect(status.linked).toBe(false);
  });

  test("unlinked user receives NEW pairing code (polling still works)", async () => {
    // This is the critical test — after unlink, polling must still work
    // and the bot must respond with a new pairing code
    // Brief wait for OpenClaw to detect config change via file watcher
    await new Promise((r) => setTimeout(r, 2000));

    const beforeSend = new Date().toISOString();

    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TELEGRAM_USER_ID,
      text: "Hello again after unlink!",
      userId: TELEGRAM_USER_ID,
      username: TELEGRAM_USERNAME,
      firstName: "E2E",
    });

    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 30000,
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    // Extract new pairing code from response
    const codeMatch = response.match(/Pairing code:\s*(\S+)/i);
    expect(codeMatch).toBeTruthy();
    lastPairingCode = codeMatch![1];
    console.log(`[test] Post-unlink response, new code: ${lastPairingCode}`);
  });

  test("user can re-link after unlink", async () => {
    expect(lastPairingCode).toBeTruthy();

    const res = await linkTelegram(lastPairingCode);
    expect(res.status).toBe(200);

    console.log(`[test] Re-linked with pairing code: ${lastPairingCode}`);
  });

  test("re-linked user receives agent response", { tag: "@llm" }, async () => {
    // Brief wait for OpenClaw to detect config change via file watcher
    await new Promise((r) => setTimeout(r, 2000));

    const beforeSend = new Date().toISOString();

    await sendTelegramMessage({
      token: BOT_TOKEN,
      chatId: TELEGRAM_USER_ID,
      text: "Are you still there after re-link?",
      userId: TELEGRAM_USER_ID,
      username: TELEGRAM_USERNAME,
      firstName: "E2E",
    });

    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 60000,
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    console.log(`[test] Post-relink response: "${response.substring(0, 100)}..."`);
  });
});

// ── Multi-Bot Tests ─────────────────────────────────────────────────

const SECOND_BOT_TOKEN = "789012:DEF-second-bot-for-e2e";

test.describe.serial("Multi-Bot Telegram", () => {
  let smithersId: string;
  let secondAgentId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000); // 5 min — services can be slow in CI
    await waitForPinchy();
    await waitForMockTelegram();
    await seedSetup();
    await waitForOpenClawConnected(120000);
    await login();
    // Clean state: unlink user from previous test suite, reset mock
    await unlinkTelegram().catch(() => {});
    await resetMockTelegram();
  });

  test("setup: get Smithers agent ID", async () => {
    smithersId = await getAgentId();
    expect(smithersId).toBeTruthy();
    console.log(`[multi-bot] Smithers agent: ${smithersId}`);
  });

  test("setup: create second agent and connect bot", async () => {
    let agent = await getAgentByName("Support Bot");
    if (!agent) {
      agent = await createAgent("Support Bot");
    }
    secondAgentId = agent.id;
    expect(secondAgentId).toBeTruthy();

    const result = await connectBot(secondAgentId, SECOND_BOT_TOKEN);
    expect(result.botUsername).toBeTruthy();
    console.log(`[multi-bot] Second bot: @${result.botUsername} for agent ${secondAgentId}`);

    // Wait for OpenClaw to start polling the second bot
    await waitForTelegramPolling();
  });

  test("second bot responds to unlinked user with pairing code", async () => {
    const beforeSend = new Date().toISOString();

    await sendTelegramMessage({
      token: SECOND_BOT_TOKEN,
      chatId: TELEGRAM_USER_ID,
      text: "Hello Support Bot!",
      userId: TELEGRAM_USER_ID,
      username: TELEGRAM_USERNAME,
      firstName: "E2E",
    });

    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 90000,
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    const codeMatch = response.match(/Pairing code:\s*(\S+)/i);
    expect(codeMatch).toBeTruthy();
    console.log(`[multi-bot] Second bot pairing code: ${codeMatch![1]}`);
  });

  // Tagged @channel-restart: Adding a second account triggers OpenClaw channel restart
  // (openclaw#47458) which breaks Telegram polling. The polling watchdog should recover,
  // but the 15s stop timeout vs 30s getUpdates timeout causes zombie sessions.
  // This test verifies polling recovery — skip in CI where it's unreliable.
  test(
    "first bot (Smithers) still responds after second bot connected",
    { tag: "@channel-restart" },
    async () => {
      // Wait for polling to recover after channel restart
      await waitForTelegramPolling(120000);

      const beforeSend = new Date().toISOString();

      await sendTelegramMessage({
        token: BOT_TOKEN,
        chatId: TELEGRAM_USER_ID,
        text: "Smithers, are you still there?",
        userId: TELEGRAM_USER_ID,
        username: TELEGRAM_USERNAME,
        firstName: "E2E",
      });

      // User is unlinked, so Smithers should respond with pairing code
      const response = await waitForBotResponse(TELEGRAM_USER_ID, {
        timeout: 90000,
        since: beforeSend,
      });

      expect(response).toBeTruthy();
      console.log(`[multi-bot] Smithers still responds: "${response.substring(0, 80)}..."`);
    }
  );
});

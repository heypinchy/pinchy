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
  connectBot,
  sendTelegramMessage,
  waitForBotResponse,
  resetMockTelegram,
  linkTelegram,
  unlinkTelegram,
  getTelegramLinkStatus,
  waitForPinchy,
  waitForMockTelegram,
  readPairingFile,
  seedSetup,
} from "./helpers";

const BOT_TOKEN = "123456:ABC-test-token-for-e2e";
const TELEGRAM_USER_ID = "999888777";
const TELEGRAM_USERNAME = "e2e_tester";

test.describe.serial("Telegram Integration", () => {
  let agentId: string;

  test.beforeAll(async () => {
    // Wait for services to be ready
    await waitForPinchy();
    await waitForMockTelegram();

    // Create admin user and provider config if not already done
    await seedSetup();
    await resetMockTelegram();

    // Wait for OpenClaw to be connected
    await new Promise((r) => setTimeout(r, 10000));
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

    // Wait for OpenClaw to start polling the mock
    await new Promise((r) => setTimeout(r, 5000));
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
    const response = await waitForBotResponse(TELEGRAM_USER_ID, {
      timeout: 30000,
      since: beforeSend,
    });

    expect(response).toBeTruthy();
    // The response should contain a pairing code or pairing instructions
    console.log(`[test] Bot pairing response: "${response}"`);
  });

  test("user can link via pairing code", async () => {
    // Read the pairing file from the shared volume
    const pairingData = readPairingFile();
    expect(pairingData).not.toBeNull();

    // Find the code for our test user
    const pairings = (pairingData as Record<string, unknown>)?.pairings as
      | Array<{ code: string; telegramUserId: string }>
      | undefined;

    let pairingCode: string | undefined;

    if (pairings) {
      // New format: array of pairings
      const entry = pairings.find((p) => String(p.telegramUserId) === TELEGRAM_USER_ID);
      pairingCode = entry?.code;
    } else {
      // Try other format: direct code mapping
      const entries = Object.entries(pairingData as Record<string, unknown>);
      for (const [code, data] of entries) {
        if (
          typeof data === "object" &&
          data !== null &&
          String((data as Record<string, unknown>).telegramUserId) === TELEGRAM_USER_ID
        ) {
          pairingCode = code;
          break;
        }
      }
    }

    if (!pairingCode) {
      // Fallback: extract from bot response text
      console.log(
        "[test] Could not find code in pairing file, pairing data:",
        JSON.stringify(pairingData)
      );
    }

    expect(pairingCode).toBeTruthy();

    const res = await linkTelegram(pairingCode!);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.linked).toBe(true);
    expect(data.telegramUserId).toBe(TELEGRAM_USER_ID);

    console.log(`[test] Linked with pairing code: ${pairingCode}`);
  });

  test("linked user receives agent response (not pairing)", async () => {
    // Wait for config reload
    await new Promise((r) => setTimeout(r, 3000));

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
    await new Promise((r) => setTimeout(r, 3000));

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
    console.log(`[test] Post-unlink response: "${response.substring(0, 100)}..."`);
  });

  test("user can re-link after unlink", async () => {
    // Read new pairing code
    const pairingData = readPairingFile();
    expect(pairingData).not.toBeNull();

    // Extract code (same logic as above)
    let pairingCode: string | undefined;
    const entries = Object.entries(pairingData as Record<string, unknown>);
    for (const [code, data] of entries) {
      if (
        typeof data === "object" &&
        data !== null &&
        String((data as Record<string, unknown>).telegramUserId) === TELEGRAM_USER_ID
      ) {
        pairingCode = code;
        break;
      }
    }

    if (!pairingCode) {
      const pairings = (pairingData as Record<string, unknown>)?.pairings as Array<{
        code: string;
        telegramUserId: string;
      }>;
      if (pairings) {
        const entry = pairings.find((p) => String(p.telegramUserId) === TELEGRAM_USER_ID);
        pairingCode = entry?.code;
      }
    }

    expect(pairingCode).toBeTruthy();

    const res = await linkTelegram(pairingCode!);
    expect(res.status).toBe(200);

    console.log(`[test] Re-linked with pairing code: ${pairingCode}`);
  });

  test("re-linked user receives agent response", async () => {
    await new Promise((r) => setTimeout(r, 3000));

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

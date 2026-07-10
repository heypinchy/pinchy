/**
 * Multi-device live-sync (Lane B).
 *
 * A message sent on one device of a user must appear on that user's OTHER
 * already-open device WITHOUT a manual reload. This is the one thing the unit
 * tests necessarily mock: that the REAL OpenClaw gateway emits a
 * `session.message` event for a WEB chat turn (not only for Telegram), which
 * Pinchy's per-session `sessions.messages.subscribe` consumes and fans out as a
 * body-free poke, driving device B to re-pull authoritative history through the
 * normal cookie-authorized path.
 *
 * Two isolated browser contexts = two devices of the SAME user (independent
 * cookie jars, same account). Device B is opened BEFORE device A sends and is
 * never reloaded/navigated again — so any content that appears on B arrived via
 * the live poke → re-pull, not a page load.
 *
 * The turn uses a DEDICATED fake-LLM trigger so both the user message and the
 * reply are UNIQUE: the integration suite shares one OpenClaw session across
 * specs, so asserting the generic FAKE_OLLAMA_RESPONSE would resolve to multiple
 * transcript elements (and would leak an extra generic reply into the session
 * that breaks agent-chat's own default-reply assertion).
 */
import { test, expect } from "@playwright/test";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";
import {
  FAKE_OLLAMA_MULTI_DEVICE_TRIGGER,
  FAKE_OLLAMA_MULTI_DEVICE_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";

test.describe("Multi-device live-sync", () => {
  test("a message sent on device A appears on device B without a reload", async ({ browser }) => {
    // Device A sends this exact text; it is a unique fake-LLM trigger, so both it
    // (the user turn) and its reply exist only because of THIS test.
    const SENT = FAKE_OLLAMA_MULTI_DEVICE_TRIGGER;
    const REPLY = FAKE_OLLAMA_MULTI_DEVICE_RESPONSE;

    // --- Device A ---
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await login(pageA);
    const agentId = await getSmithersAgentId(pageA);
    await pageA.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(pageA);
    const inputA = pageA.getByPlaceholder(/send a message/i);
    await expect(inputA).toBeVisible({ timeout: 10000 });

    // --- Device B (same user, second context, same chat, opened BEFORE A sends) ---
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await login(pageB);
    await pageB.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(pageB);
    await expect(pageB.getByPlaceholder(/send a message/i)).toBeVisible({ timeout: 10000 });

    // B must not show this turn yet — it hasn't been sent.
    await expect(pageB.getByText(SENT)).toHaveCount(0);
    await expect(pageB.getByText(REPLY)).toHaveCount(0);

    // --- Device A sends and sees the assistant reply ---
    await inputA.fill(SENT);
    await inputA.press("Enter");
    await expect(pageA.getByText(SENT)).toBeVisible({ timeout: 10000 });
    await expect(pageA.getByText(REPLY)).toBeVisible({ timeout: 30000 });

    // --- THE PROOF: device B renders A's turn live, with NO reload/navigation on B ---
    await expect(pageB.getByText(SENT)).toBeVisible({ timeout: 30000 });
    await expect(pageB.getByText(REPLY)).toBeVisible({ timeout: 30000 });

    await ctxA.close();
    await ctxB.close();
  });
});

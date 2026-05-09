// packages/web/e2e/integration/15-stream-persistence.spec.ts
import { test, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import {
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
  FAKE_OLLAMA_SLOW_STREAM_DELAY_MS,
} from "./fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const RESPONSE_WORDS = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ");
const FIRST_WORD = RESPONSE_WORDS[0]!;
const LAST_WORD = RESPONSE_WORDS[RESPONSE_WORDS.length - 1]!;

test.describe("Stream persistence — #199 Layer A + B end-to-end", () => {
  test("user msg + reply survive mid-stream context-close", async ({ browser }) => {
    // First context: send a slow-streaming message, observe first token, then close.
    const ctx1: BrowserContext = await browser.newContext();
    const page1 = await ctx1.newPage();
    await login(page1);
    const agentId = await getSmithersAgentId(page1);

    await page1.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page1);

    const input = page1.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    const userText = `${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`;
    await input.fill(userText);
    // Press Enter to submit — matches the working pattern in agent-chat.spec.ts
    // and avoids the disabled-button race when chatStatus.kind is not yet "ready".
    await input.press("Enter");

    // Wait for the first assistant token to render — proves the stream is live
    // and we're closing context mid-stream (essential for the Layer B half).
    // Scope to data-role="assistant" so we don't accidentally match the user
    // message bubble or any greeting text.
    await expect(
      page1.locator('[data-role="assistant"]').filter({ hasText: FIRST_WORD })
    ).toBeVisible({ timeout: 30000 });

    // Close the entire context — simulates the user closing the tab/window
    // while OpenClaw is still streaming.
    await ctx1.close();

    // Allow remaining tokens to drain on the server side.
    // Derived from stream parameters: total stream duration plus a 3s CI buffer.
    const remainingStreamMs = FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * RESPONSE_WORDS.length;
    await new Promise((r) => setTimeout(r, remainingStreamMs + 3000));

    // Fresh context — no shared cookies, no shared websocket. This is what a
    // user reload looks like to Pinchy.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await login(page2);
    await page2.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page2);

    // Layer A guard: the user message must survive reload. The trigger string
    // is unique to the user message (it's not echoed in the assistant reply).
    await expect(
      page2.locator('[data-role="user"]').filter({ hasText: FAKE_OLLAMA_SLOW_STREAM_TRIGGER })
    ).toBeVisible({ timeout: 30000 });

    // Layer B guard: the assistant reply must be fully drained, not partial.
    // Asserting on the full canonical response would also fail on a partial,
    // but a separate last-word check makes the failure mode obvious in the
    // Playwright report ("got 'one two three' wanted 'ten'").
    const assistantMessage = page2.locator('[data-role="assistant"]').last();
    await expect(assistantMessage).toContainText(LAST_WORD, { timeout: 30000 });
    await expect(assistantMessage).toContainText(FAKE_OLLAMA_SLOW_STREAM_RESPONSE, {
      timeout: 5000,
    });

    await ctx2.close();
  });
});

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

test.describe("In-app navigation chat persistence (#199)", () => {
  test("mid-stream in-app navigation + return preserves the live stream", async ({ browser }) => {
    const ctx: BrowserContext = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Wait for first token to confirm stream is live.
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: FIRST_WORD })
    ).toBeVisible({ timeout: 30000 });

    // In-app navigate away.
    await page.goto("/agents");

    // Wait for the stream to complete server-side.
    const remainingStreamMs = FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * RESPONSE_WORDS.length;
    await new Promise((r) => setTimeout(r, remainingStreamMs + 3000));

    // Navigate back to the chat.
    await page.goto(`/chat/${agentId}`);

    // Full assistant reply must be visible quickly — bundle was alive in the background.
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
      { timeout: 5000 }
    );

    await ctx.close();
  });

  test("sidebar shows the running indicator while navigated away", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Wait for first token, then navigate away.
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: FIRST_WORD })
    ).toBeVisible({ timeout: 30000 });

    await page.goto("/agents");

    // Indicator must be visible on the agents/sidebar page.
    await expect(page.locator('[data-testid="agent-running-indicator"]')).toBeVisible({
      timeout: 5000,
    });

    // Wait for stream completion.
    const remainingStreamMs = FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * RESPONSE_WORDS.length;
    await new Promise((r) => setTimeout(r, remainingStreamMs + 3000));

    // Indicator must clear within ~1s of completion.
    await expect(page.locator('[data-testid="agent-running-indicator"]')).toBeHidden({
      timeout: 2000,
    });

    await ctx.close();
  });
});

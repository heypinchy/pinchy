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

  test("two concurrent in-flight turns each show running indicator", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);

    const smithersId = await getSmithersAgentId(page);

    // Create a second test agent via API.
    const createRes = await page.request.post("/api/agents", {
      data: { name: `ConcurrentTest-${Date.now()}`, templateId: "custom" },
    });
    expect(createRes.status()).toBeLessThan(300);
    const second = await createRes.json();

    // Send slow prompt to Smithers and wait for first token (stream is live).
    await page.goto(`/chat/${smithersId}`);
    await waitForOpenClawConnected(page);
    const input1 = page.getByPlaceholder(/send a message/i);
    await expect(input1).toBeVisible({ timeout: 10000 });
    await input1.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input1.press("Enter");
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: FIRST_WORD })
    ).toBeVisible({ timeout: 30000 });

    // Navigate to second agent and send another slow prompt. OpenClaw is
    // already connected so we skip waitForOpenClawConnected.
    await page.goto(`/chat/${second.id}`);
    const input2 = page.getByPlaceholder(/send a message/i);
    await expect(input2).toBeVisible({ timeout: 10000 });
    await input2.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input2.press("Enter");

    // Wait for BOTH sidebar pulse-dots to be visible BEFORE navigating away.
    // The sidebar is rendered on the chat page too, so this wait happens
    // entirely while the second stream is starting — no need to navigate
    // first, no race against Smithers finishing. This is the assertion the
    // test was originally trying to make.
    await expect(page.locator('[data-testid="agent-running-indicator"]')).toHaveCount(2, {
      timeout: 10000,
    });

    // Now navigate away. Both must still be running (background-mode promise).
    await page.goto("/agents");
    await expect(page.locator('[data-testid="agent-running-indicator"]')).toHaveCount(2, {
      timeout: 5000,
    });

    // Wait for both streams to complete fully.
    const fullStreamMs = FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * RESPONSE_WORDS.length;
    await new Promise((r) => setTimeout(r, fullStreamMs + 5000));

    await expect(page.locator('[data-testid="agent-running-indicator"]')).toHaveCount(0, {
      timeout: 2000,
    });

    await ctx.close();
  });

  test("composer draft survives in-app navigation", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    const draft = "this is a half-typed thought";
    await input.fill(draft);

    await page.goto("/agents");
    await page.goto(`/chat/${agentId}`);

    await expect(page.getByPlaceholder(/send a message/i)).toHaveValue(draft, {
      timeout: 5000,
    });

    await ctx.close();
  });
});

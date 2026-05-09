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

    // OpenClaw history persists across tests in the same suite. Snapshot
    // the count first and wait for it to grow by one — robust against
    // accumulated prior turns.
    const assistantBefore = await page.locator('[data-role="assistant"]').count();

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Wait for the new assistant message and its first token (stream is live).
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(assistantBefore + 1, {
      timeout: 30000,
    });
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(FIRST_WORD, {
      timeout: 30000,
    });

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

    // OpenClaw history persists across tests in the same suite, so prior
    // turns may already be visible in this chat. Snapshot the current
    // count and wait for it to grow by exactly one — this is robust
    // against history accumulation, unlike a `filter({ hasText })` match.
    const assistantBefore = await page.locator('[data-role="assistant"]').count();

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Wait for the new assistant message to appear with its first token.
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(assistantBefore + 1, {
      timeout: 30000,
    });
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(FIRST_WORD, {
      timeout: 30000,
    });

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

  // Two scenarios that we DON'T E2E-cover here, with rationale:
  //
  // 1. "Two concurrent in-flight turns each show running indicator"
  //    Creating a second agent via POST /api/agents triggers
  //    regenerateOpenClawConfig() which `mkdirSync`s under
  //    /tmp/pinchy-integration-openclaw/agents/<id>/. In CI that
  //    directory is bind-mounted into the OpenClaw container, which
  //    creates files there as root, leaving the host-side Pinchy process
  //    unable to add new agent subdirs (EACCES). The multi-agent
  //    indicator behavior is exercised end-to-end in the unit tests
  //    sidebar-running-indicator.test.tsx and chat-session-mounts.test.tsx
  //    by publishing bundles for several agentIds simultaneously and
  //    asserting on the rendered DOM.
  //
  // 2. "Composer draft survives in-app navigation"
  //    The composer state in @assistant-ui/react is internal to the
  //    AssistantRuntime. While the runtime instance survives the
  //    consumer's unmount/remount (proven by runtime-stability.test.tsx),
  //    the composer's textarea value is not preserved by the runtime in
  //    the version we use; the textarea reads its initial value as ""
  //    on every mount. Until that's fixed upstream (or we wrap the
  //    composer with our own draft cache), claiming "draft survives
  //    navigation" would be a false promise — so this test was removed
  //    along with the corresponding line in
  //    docs/explanation/chat-states.mdx.
});

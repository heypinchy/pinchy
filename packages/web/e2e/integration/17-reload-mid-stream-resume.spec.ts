// packages/web/e2e/integration/17-reload-mid-stream-resume.spec.ts
//
// Regression guard for the streaming-resume duplicate-message-id crash.
//
// Reloading the SAME tab while a reply is still streaming exercises the
// `activeRun` resume path: the reconnecting client fetches history + an
// activeRun signal and re-attaches to the in-flight run. A prior bug let the
// in-flight assistant message be materialised twice with the same id, which
// crashes assistant-ui's MessageRepository and replaces the chat with the
// "Something went wrong" error boundary. (Fixed by dedupeById + mergeOrAppendChunk.)
//
// With the fix this is reliably green: whether the reload lands on the resume
// path (run still in-flight) or the history path (run finished during reload),
// the view must NOT crash and the reply must complete in a single bubble.
import { test, expect } from "@playwright/test";
import {
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const RESPONSE_WORDS = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ");
const FIRST_WORD = RESPONSE_WORDS[0]!;
const LAST_WORD = RESPONSE_WORDS[RESPONSE_WORDS.length - 1]!;

test.describe("Streaming resume — reload mid-stream does not crash the chat view", () => {
  test("reloading the tab while streaming resumes the reply without an error boundary", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // This agent's chat history is shared across integration specs, so earlier
    // slow-stream tests have already produced assistant bubbles containing the
    // first word. Anchor on the bubble COUNT (and .last()) rather than text-
    // filtering, which would match those stale bubbles in strict mode.
    const assistantBubbles = page.locator('[data-role="assistant"]');
    const before = await assistantBubbles.count();

    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Our reply opens a new bubble and starts streaming — the run is now
    // in-flight and we're about to reload mid-stream (the resume path).
    // Poll for "at least one more bubble" so a transient thinking indicator
    // doesn't break an exact-count assertion.
    await expect
      .poll(async () => assistantBubbles.count(), { timeout: 30000 })
      .toBeGreaterThan(before);
    await expect(assistantBubbles.last()).toContainText(FIRST_WORD, { timeout: 30000 });

    // Reload the SAME tab mid-stream — this is what previously crashed the view.
    await page.reload();
    await waitForOpenClawConnected(page);

    // The error boundary must NOT have replaced the chat view.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);

    // The reply resumes and completes in a single bubble (no orphan/duplicate).
    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await expect(assistantMessage).toContainText(LAST_WORD, { timeout: 30000 });
    await expect(assistantMessage).toContainText(FAKE_OLLAMA_SLOW_STREAM_RESPONSE, {
      timeout: 5000,
    });

    // The composer is still interactive — a crashed view would have no input.
    await expect(page.getByPlaceholder(/send a message/i)).toBeVisible();
  });
});

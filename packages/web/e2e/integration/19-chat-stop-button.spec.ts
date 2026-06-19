// packages/web/e2e/integration/19-chat-stop-button.spec.ts
//
// End-to-end proof for the re-enabled chat stop button (#550), run against a
// real OpenClaw 2026.6.5 container.
//
// This spec is BOTH the feature E2E and the empirical gate for the upstream
// fix. The stop button was shipped once (PR #23) and rolled back (PR #136)
// because OpenClaw's `chat.abort` was a no-op on `agent`-RPC runs — it returned
// `{ aborted: false }` and, worse, never released the session lane, so every
// subsequent message on that session came back empty (openclaw/openclaw#42172,
// fixed 2026-04-26, shipped in our pinned OC 2026.6.5).
//
// The two assertions that matter most here therefore mirror the two ways the
// old implementation lied:
//   1. The stream actually stops (the full ten-word reply never lands).
//   2. The SAME session is immediately reusable — a second message gets a real
//      reply. This is the session-lane-release regression guard; if the
//      upstream fix ever regresses, this is the assertion that goes red.
import { test, expect } from "@playwright/test";
import {
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_RESPONSE,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const STREAM_WORDS = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ");
const STREAM_FIRST_WORD = STREAM_WORDS[0]!;
const STREAM_LAST_WORD = STREAM_WORDS[STREAM_WORDS.length - 1]!;

test.describe("Chat stop button — user-triggered abort (#550)", () => {
  test("stops the run, audits chat.run_aborted, and leaves the session reusable", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // 1. Kick off a genuinely incremental reply (~500ms/word, ten words). Keep
    //    the prompt free of the response's words so the last-word assertion in
    //    step 5 can never be satisfied by the echoed user message.
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: please respond slowly`);
    await input.press("Enter");

    // 2. The run is STARTED (not merely pending): the stop button is showing
    //    AND the first word has streamed. The openclaw#42172 bug was about
    //    started runs, so we deliberately abort one mid-stream.
    const stopButton = page.getByRole("button", { name: "Stop generating" });
    await expect(stopButton).toBeVisible({ timeout: 15000 });
    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await expect(assistantMessage).toContainText(STREAM_FIRST_WORD, { timeout: 15000 });

    // 3. Click stop.
    await stopButton.click();

    // 4. The turn ends client-side: the stop button is replaced by the send
    //    affordance (composer re-enabled).
    await expect(stopButton).toBeHidden({ timeout: 10000 });

    // 5. The stream actually stopped server-side: the final word never lands.
    //    With the old no-op abort the reply would run to completion ("ten").
    //    Give it well over the remaining stream time to be sure.
    await page.waitForTimeout(4000);
    await expect(assistantMessage).not.toContainText(STREAM_LAST_WORD);

    // 6. The abort is audited as chat.run_aborted (actor = user, success).
    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/audit?eventType=chat.run_aborted&limit=10");
          if (res.status() !== 200) return false;
          const data = (await res.json()) as {
            entries: Array<{
              resource: string | null;
              outcome: string | null;
              detail: { reason?: string } | null;
            }>;
          };
          return data.entries.some(
            (e) =>
              e.resource === `agent:${agentId}` &&
              e.outcome === "success" &&
              e.detail?.reason === "user_request"
          );
        },
        { timeout: 15000 }
      )
      .toBe(true);

    // 7. THE regression guard: the same session is immediately reusable. Under
    //    openclaw#42172 the lane lock was never released and this second
    //    message would come back as an empty `done`. It must get a real reply.
    await input.fill("Hello again — are you there?");
    await input.press("Enter");
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      FAKE_OLLAMA_RESPONSE,
      { timeout: 30000 }
    );
  });
});

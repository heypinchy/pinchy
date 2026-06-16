// packages/web/e2e/integration/18-chat-liveness.spec.ts
//
// Chat-liveness end-to-end guards (chat-liveness-observer Task 5.1), driven
// against the REAL stack: Pinchy + OpenClaw + the fake-ollama server. These are
// the through-the-wire counterparts to the in-process liveness unit tests.
//
// The feature: the chat client no longer guesses agent liveness from silence.
// A slow-but-alive run shows a "taking longer than usual" banner and NEVER a
// failure bubble; a failure is shown ONLY from an authoritative server signal
// (the OpenClaw run-liveness verdict relayed as a `liveness: failed` frame).
//
// Two fake-ollama triggers drive the two states (see fake-ollama-server.ts):
//   - FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER  → stalls past the client's
//       "taking longer" threshold (DELAY_HINT_MS = 15s in use-ws-runtime.ts),
//       then streams a normal reply and completes. Drives the banner.
//   - FAKE_OLLAMA_LIVENESS_DYING_TRIGGER → opens the stream, emits a partial
//       token, then the provider stream dies — an authoritative terminal
//       failure.
//
// Harness pattern mirrors 15-stream-persistence.spec.ts and
// 17-reload-mid-stream-resume.spec.ts exactly: shared `login` /
// `getSmithersAgentId` / `waitForOpenClawConnected` helpers, the
// `getByPlaceholder(/send a message/i)` composer, and `input.press("Enter")`
// to submit (avoids the disabled-button race when chatStatus isn't yet
// "ready"). Smithers' chat history is shared across integration specs, so we
// anchor on `data-role="assistant"` bubble COUNT/.last() rather than text
// filters that could match stale bubbles from earlier specs.
import { test, expect } from "@playwright/test";
import {
  FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER,
  FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE,
  FAKE_OLLAMA_LIVENESS_DYING_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

// On-screen copy (do NOT hardcode loosely — these are the real strings):
//   - "taking longer" banner: chat.tsx → ChatStatusBanner
const TAKING_LONGER_BANNER = /taking longer than usual/i;
//   - failure bubble heading: chat-error-message.tsx provider-error branch
//     renders "<agent> couldn't respond"
const COULDNT_RESPOND = /couldn'?t respond/i;
// Strings the OLD client-side guess produced. They were deleted with the orphan
// detector and must NEVER appear during a slow-but-alive run.
const OBSOLETE_FAILURE_COPY = [/didn'?t respond/i, /couldn'?t respond/i];

const SLOW_RESPONSE_WORDS = FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE.split(" ");
const SLOW_RESPONSE_LAST_WORD = SLOW_RESPONSE_WORDS[SLOW_RESPONSE_WORDS.length - 1]!;

const NORMAL_STREAM_WORDS = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ");
const NORMAL_STREAM_FIRST_WORD = NORMAL_STREAM_WORDS[0]!;
const NORMAL_STREAM_LAST_WORD = NORMAL_STREAM_WORDS[NORMAL_STREAM_WORDS.length - 1]!;

test.describe("Chat liveness — slow run banner, dying run failure", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // REGRESSION TEST for the production false-failure bug.
  //
  // A slow-but-alive run must show the "taking longer than usual" banner and
  // must NEVER show a failure bubble — then render the real reply. The fake
  // server stalls ~18s before the first token (past the 15s banner threshold),
  // so the banner engages BEFORE any assistant text appears, proving the slow
  // state is reached, and the run still completes successfully afterwards.
  // ────────────────────────────────────────────────────────────────────────────
  test("slow run shows the 'taking longer' banner and never a failure bubble", async ({ page }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    const assistantBubbles = page.locator('[data-role="assistant"]');
    // Scope to chat failure bubbles (chat-error-message renders role="alert"
    // INSIDE an assistant message). Page chrome — the insecure-connection and
    // enterprise/license banners — also use role="alert", so a bare
    // [role="alert"] locator would always match them and is NOT a failure signal.
    const errorAlerts = page.locator('[data-role="assistant"] [role="alert"]');

    await input.fill(`${FAKE_OLLAMA_LIVENESS_SLOW_TRIGGER}: please take your time`);
    await input.press("Enter");

    // The banner appears during the stall (server holds the first token ~18s,
    // the client flips isDelayed at 15s). 25s timeout covers the 15s threshold
    // plus reconnect/dispatch latency on a loaded CI host.
    await expect(page.getByText(TAKING_LONGER_BANNER)).toBeVisible({ timeout: 25000 });

    // CARDINAL ASSERTION: while slow-but-alive, NO failure/error bubble may show.
    // The banner is a soft "still working" hint, never a terminal failure.
    await expect(errorAlerts).toHaveCount(0);
    for (const obsolete of OBSOLETE_FAILURE_COPY) {
      await expect(page.getByText(obsolete)).toHaveCount(0);
    }

    // The run then completes successfully: the real reply renders to its last
    // word, and the banner clears once the stream finishes.
    const assistantMessage = assistantBubbles.last();
    await expect(assistantMessage).toContainText(SLOW_RESPONSE_LAST_WORD, { timeout: 30000 });
    await expect(assistantMessage).toContainText(FAKE_OLLAMA_LIVENESS_SLOW_RESPONSE, {
      timeout: 5000,
    });
    await expect(page.getByText(TAKING_LONGER_BANNER)).toHaveCount(0);

    // Final guard: still no failure bubble after the successful completion.
    await expect(errorAlerts).toHaveCount(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // A dying provider stream is an authoritative terminal failure. Exactly one
  // failure bubble (with a Retry affordance) appears and the spinner stops.
  // ────────────────────────────────────────────────────────────────────────────
  test("dying run shows exactly one authoritative failure bubble with retry", async ({ page }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    await input.fill(`${FAKE_OLLAMA_LIVENESS_DYING_TRIGGER}: this stream will die`);
    await input.press("Enter");

    // A single authoritative failure bubble appears. The dying provider stream
    // surfaces a provider error ("<agent> couldn't respond" — see
    // chat-error-message.tsx) plus the `liveness: failed` verdict; the client
    // dedupes to ONE error bubble (use-ws-runtime.ts removes any prior error
    // before rendering, and the liveness verdict is suppressed when an error
    // bubble already exists).
    const errorAlert = page.locator('[role="alert"]').filter({ hasText: COULDNT_RESPOND });
    await expect(errorAlert).toHaveCount(1, { timeout: 30000 });

    // The Retry affordance must be present on the failure bubble.
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 5000 });

    // The spinner stops: the connection indicator leaves "Responding..." once
    // the failure is terminal. Asserting the absence of the responding label is
    // a robust proxy for "spinner stopped" without coupling to internal markup.
    await expect(page.getByText("Responding...")).toHaveCount(0, { timeout: 10000 });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Reload mid-stream → streaming resumes, no false failure. Uses the normal
  // slow-stream trigger (genuinely incremental, ~500ms/word) so we can reliably
  // observe the first token, reload the SAME tab mid-stream, and assert the
  // reply is present and complete after reload with no failure bubble.
  //
  // This complements 17-reload-mid-stream-resume.spec.ts (which guards the
  // duplicate-message-id crash) by adding the liveness invariant: a mid-stream
  // reload must NEVER produce a failure bubble.
  // ────────────────────────────────────────────────────────────────────────────
  test("reload mid-stream resumes the reply without a false failure bubble", async ({ page }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    const assistantBubbles = page.locator('[data-role="assistant"]');
    const before = await assistantBubbles.count();

    await input.fill(
      `${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${NORMAL_STREAM_FIRST_WORD}..${NORMAL_STREAM_LAST_WORD}`
    );
    await input.press("Enter");

    // Our reply opens a new bubble and starts streaming — the run is now
    // in-flight. Poll for "at least one more bubble" so a transient thinking
    // indicator doesn't break an exact-count assertion.
    await expect
      .poll(async () => assistantBubbles.count(), { timeout: 30000 })
      .toBeGreaterThan(before);
    await expect(assistantBubbles.last()).toContainText(NORMAL_STREAM_FIRST_WORD, {
      timeout: 30000,
    });

    // Reload the SAME tab mid-stream.
    await page.reload();
    await waitForOpenClawConnected(page);

    // No error boundary, and — the liveness invariant — no chat failure bubble.
    // Scope to in-thread alerts; the page-level insecure/enterprise banners also
    // use role="alert" and are not failure signals.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    await expect(page.locator('[data-role="assistant"] [role="alert"]')).toHaveCount(0);

    // The reply resumes and completes in a single bubble.
    const assistantMessage = page.locator('[data-role="assistant"]').last();
    await expect(assistantMessage).toContainText(NORMAL_STREAM_LAST_WORD, { timeout: 30000 });
    await expect(assistantMessage).toContainText(FAKE_OLLAMA_SLOW_STREAM_RESPONSE, {
      timeout: 5000,
    });

    // The composer is still interactive — a failed/crashed view would not be.
    await expect(page.getByPlaceholder(/send a message/i)).toBeVisible();
  });
});

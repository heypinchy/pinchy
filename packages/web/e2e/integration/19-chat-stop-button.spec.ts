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
//
// Both the mid-stream gate and the final assertion are deliberately scoped to
// THIS run's reply via a word list only this spec can trigger. The integration
// suite shares one OpenClaw session, so the generic E2E_SLOW_STREAM reply is
// already in the history from specs 15-18 — see the comment on
// FAKE_OLLAMA_ABORT_STREAM_TRIGGER for the flake that cost us.
import { test, expect } from "@playwright/test";
import {
  FAKE_OLLAMA_ABORT_STREAM_TRIGGER,
  FAKE_OLLAMA_RESPONSE,
  FAKE_OLLAMA_ABORT_STREAM_RESPONSE,
  FAKE_OLLAMA_ABORT_STREAM_DEFAULT_DELAY_MS,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

const STREAM_WORDS = FAKE_OLLAMA_ABORT_STREAM_RESPONSE.split(" ");
const STREAM_FIRST_WORD = STREAM_WORDS[0]!;
const STREAM_LAST_WORD = STREAM_WORDS[STREAM_WORDS.length - 1]!;

test.describe("Chat stop button — user-triggered abort (#550)", () => {
  test("stops the run, audits chat.run_aborted, and leaves the session reusable", async ({
    page,
  }) => {
    // Count the `history` frames the chat socket RECEIVES. Step 5 forces a
    // history catch-up and has to wait for it; there is no DOM change to key
    // off, because the whole point of the assertion that follows is that the
    // reconcile changes nothing. The frame itself is the event — attached
    // before the first navigation so the socket cannot open ahead of us.
    let historyFrames = 0;
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        if (typeof frame.payload !== "string") return;
        try {
          if ((JSON.parse(frame.payload) as { type?: string }).type === "history") historyFrames++;
        } catch {
          // Not one of ours — the chat protocol is JSON text frames only.
        }
      });
    });

    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // 1. Kick off a genuinely incremental reply (~500ms/word, ten words). Keep
    //    the prompt free of the response's words so the last-word assertion in
    //    step 5 can never be satisfied by the echoed user message.
    await input.fill(`${FAKE_OLLAMA_ABORT_STREAM_TRIGGER}: please respond slowly`);
    await input.press("Enter");

    // 2. The run is STARTED (not merely pending): the stop button is showing
    //    AND the first word has streamed. The openclaw#42172 bug was about
    //    started runs, so we deliberately abort one mid-stream.
    //
    //    Scope the reply by its first word rather than taking `.last()` of all
    //    assistant messages: only this run can produce STREAM_FIRST_WORD, so a
    //    match cannot be an earlier spec's reply sitting in the shared session.
    //    `.last()` could — and did — resolve to one while this run's bubble was
    //    not in the DOM yet, passing the gate before a single token existed.
    const stopButton = page.getByRole("button", { name: "Stop generating" });
    await expect(stopButton).toBeVisible({ timeout: 15000 });
    const assistantMessage = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: STREAM_FIRST_WORD });
    await expect(assistantMessage).toBeVisible({ timeout: 15000 });

    // 3. Click stop. Anchor the audit window here (#978, step 9): this suite
    //    shares one OpenClaw session and the specs just before this one END
    //    RUNS ON PURPOSE, so the log already holds genuine `chat.agent_error`
    //    rows. Only what lands after the click can be about the click.
    const stoppedAt = new Date().toISOString();
    await stopButton.click();

    // 4. The turn ends client-side: the stop button is replaced by the send
    //    affordance (composer re-enabled).
    await expect(stopButton).toBeHidden({ timeout: 10000 });

    // 5. The stream actually stopped server-side: the final word never lands.
    //    With the old no-op abort the reply would run to completion.
    //    We aborted right after word one, so the nine remaining words would
    //    take DELAY_MS * 9 to arrive. Wait out the whole response length —
    //    a full word longer than that — so a stream that was NOT stopped has
    //    provably had the time to finish. (The previous fixed 4000ms was
    //    shorter than the 4500ms it was meant to outlast, which would have let
    //    a no-op abort slip through green.)
    //
    //    Sleep exemption (pinchy/no-untracked-sleeps), tracked in #952: this
    //    bounds a NEGATIVE window — there is no event that fires when tokens
    //    stop arriving, so nothing to wait on. The deterministic replacement is
    //    a fake-ollama control endpoint reporting whether this run's stream
    //    completed or was client-aborted; #952 owns building it.
    await page.waitForTimeout(FAKE_OLLAMA_ABORT_STREAM_DEFAULT_DELAY_MS * STREAM_WORDS.length);

    //    Force the history catch-up rather than hoping for it (#978). Stopping
    //    a run clears `isRunningRef`, which is the guard that refuses a mid-run
    //    re-pull — so the next poke or window focus adopts the server's history
    //    for a run whose reply OpenClaw did not persist, and the partial is
    //    gone. This spec failed exactly that way three times on unrelated PRs,
    //    and each time it read as a flake because whether the poke landed
    //    inside the window above was a coin toss. Firing `focus` here makes the
    //    re-pull happen on EVERY run, so a regression is red every time instead
    //    of once a quarter.
    //
    //    Waited on the FRAME, not on the DOM. A poll for "an assistant message
    //    exists" is already satisfied when the focus is dispatched — the
    //    greeting, the earlier specs' replies and this run's own partial are all
    //    on screen — so it would resolve on its first sample and wait for
    //    nothing, leaving the race it just forced still in flight under the
    //    assertions below. The counter proves the round trip landed; that the
    //    reconcile it starts left the reply alone is re-checked at step 9,
    //    behind a completed turn.
    const framesBeforeFocus = historyFrames;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => historyFrames, { timeout: 10000 }).toBeGreaterThan(framesBeforeFocus);

    //    Re-assert presence first: `not.toContainText` is also satisfied by a
    //    locator that matches NOTHING, so a reply that vanished from the DOM
    //    would make the assertion below pass without proving anything.
    await expect(assistantMessage).toBeVisible();
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

    // 8. The stopped reply is STILL on screen (#978). The catch-up forced at
    //    step 5 stages its reconcile behind a timer, so an assertion fired
    //    immediately after the history frame can pass and then be falsified
    //    milliseconds later. A completed follow-up turn is the anchor: it is
    //    strictly after every timer that frame started.
    await expect(assistantMessage).toBeVisible();
    await expect(assistantMessage).not.toContainText(STREAM_LAST_WORD);

    // 9. The stop was not recorded as a failure (#978). OpenClaw hands a user
    //    abort to the stream as an error chunk, which Pinchy used to audit as
    //    `chat.agent_error` and mirror into a durable "The model provider timed
    //    out." banner — blaming the provider for the user's own click.
    //
    //    Asserted on the trail rather than on the banner in the DOM. The banner
    //    is per SESSION and this suite shares one: spec 18 kills a stream on
    //    purpose immediately before this test, so its banner is legitimately on
    //    screen when we get here. A page-wide "no such text" check reads that as
    //    our failure — it did, on the first run of this assertion — which is the
    //    unscoped-assertion trap the header comment of this file already warns
    //    about for the reply itself.
    //
    //    Placed after step 7 on purpose: a completed follow-up turn on the same
    //    session proves the aborted run's pipe has finished, so a row that was
    //    going to be written has been. Without that anchor this is a negative
    //    window with nothing bounding it.
    const errs = await page.request.get(
      `/api/audit?eventType=chat.agent_error&limit=20&from=${encodeURIComponent(stoppedAt)}`
    );
    expect(errs.status()).toBe(200);
    const errBody = (await errs.json()) as {
      entries: Array<{ resource: string | null; detail: { providerError?: string } | null }>;
    };
    expect(errBody.entries.filter((e) => e.resource === `agent:${agentId}`)).toEqual([]);
  });
});

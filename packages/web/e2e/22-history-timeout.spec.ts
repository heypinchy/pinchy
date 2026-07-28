/**
 * Stalled initial history — Issue #956.
 *
 * Every other E2E in this suite runs against a server that answers the client's
 * `history` request, so nothing covered the case the user actually hit in
 * production: the frame never arrives. Before the deadline landed, the chat
 * waited for it forever — loading indicator, no error, no retry, no way out
 * except knowing to reload the page.
 *
 * This spec makes the frame disappear and asserts the two behaviours that
 * replace the dead end:
 *
 *   1. The wait ends: the chat says it didn't load and offers "Try again".
 *   2. The retry actually works: it reconnects, the (now cooperative) server
 *      answers, and the chat becomes usable — no page reload involved.
 *
 * Mock WebSocket strategy: identical to `15-model-error-ux.spec.ts` — a
 * MockWebSocket injected via `page.addInitScript()` before the page loads,
 * forwarding Next.js dev sockets and other agents to the real implementation.
 * The one difference is what it does with a `history` frame: the first
 * connection swallows it, later connections answer normally. The mock is
 * deliberately not shared from a helper module — addInitScript serializes the
 * function, so imports and outer-scope references are unavailable inside it.
 */

import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

// The client's deadline (HISTORY_TIMEOUT_MS in use-ws-runtime.ts) plus room for
// the self-heal reconnect and render. Real time, so keep the test's own budget
// well above it.
const DEADLINE_WAIT_MS = 35_000;

test.describe("stalled initial history (#956)", () => {
  test("surfaces a retry when the history frame never arrives, and recovers on retry", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const setupRes = await request.post("/api/setup", {
      data: {
        name: "Test Admin",
        email: "admin@test.local",
        password: "test-password-123",
      },
    });
    expect([201, 403]).toContain(setupRes.status());

    await seedProviderConfig();

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    // Generous: the redirect chain (/login → / → /chat/<id>) compiles three
    // routes on a cold dev server, and this spec's own budget is long anyway.
    await expect(page).toHaveURL(/\/chat\//, { timeout: 30_000 });

    const agentIdMatch = page.url().match(/\/chat\/([^/?#]+)/);
    expect(agentIdMatch).toBeTruthy();
    const agentId = agentIdMatch![1];

    await page.addInitScript(
      ({ targetAgentId }: { targetAgentId: string }) => {
        const RealWebSocket = window.WebSocket;
        // The server's willingness to answer is a page-level switch rather than
        // a per-connection counter: React's dev-mode double-mount opens two
        // sockets per page load, so "the first connection is the broken one"
        // would already be over by the time the chat renders. The test flips
        // this to true when it wants a healthy server.
        (window as unknown as { __answerHistory: boolean }).__answerHistory = false;

        class MockWebSocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;

          CONNECTING = 0;
          OPEN = 1;
          CLOSING = 2;
          CLOSED = 3;

          onopen: (() => void) | null = null;
          onmessage: ((event: { data: string }) => void) | null = null;
          onclose: (() => void) | null = null;
          onerror: (() => void) | null = null;
          readyState = 1;
          binaryType: string = "blob";

          constructor(url: string) {
            if (url.includes("/_next/")) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            if (!url.includes(targetAgentId)) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            queueMicrotask(() => this.onopen?.());
          }

          addEventListener() {}
          removeEventListener() {}

          send(raw: string) {
            const message = JSON.parse(raw) as { type?: string };

            if (message.type === "history") {
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "openclaw_status", connected: true }),
                });
              }, 0);
              // The reported fault: the request goes into a void (or its answer
              // is lost) and nothing ever comes back.
              if (!(window as unknown as { __answerHistory: boolean }).__answerHistory) return;
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "history",
                    messages: [{ role: "assistant", content: "Back from the deep." }],
                  }),
                });
              }, 5);
            }
          }

          close() {
            this.readyState = 3;
            this.onclose?.();
          }
        }

        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          writable: true,
          value: MockWebSocket,
        });
      },
      { targetAgentId: agentId }
    );

    await page.goto(`/chat/${agentId}`);

    // While inside the deadline the chat still shows the loading state — the
    // watchdog must not fire early on a merely slow server.
    await expect(page.getByTestId("welcome-skeleton")).toBeVisible({ timeout: 15_000 });

    // The wait ends with an explanation and a way out, not an endless spinner.
    const stalled = page.getByTestId("history-timeout");
    await expect(stalled).toBeVisible({ timeout: DEADLINE_WAIT_MS });
    await expect(stalled).toContainText(/didn't load/i);

    // Make the server healthy, then use the affordance the user is offered.
    // The recovery window is deliberately shorter than the deadline: the next
    // self-heal reconnect is a full deadline away, so nothing but the click can
    // produce the message below inside it.
    await page.evaluate(() => {
      (window as unknown as { __answerHistory: boolean }).__answerHistory = true;
    });
    await page.getByRole("button", { name: /try again/i }).click();
    await expect(page.getByText("Back from the deep.")).toBeVisible({ timeout: 15_000 });
    await expect(stalled).toBeHidden();
  });
});

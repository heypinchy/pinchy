import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

// Shared setup helper: registers the admin account (idempotent) and seeds
// the provider config so the app considers itself fully configured.
async function setupAdmin(request: Parameters<Parameters<typeof test>[2]>[0]["request"]) {
  const setupResponse = await request.post("/api/setup", {
    data: {
      name: "Test Admin",
      email: "admin@test.local",
      password: "test-password-123",
    },
  });
  expect([201, 403]).toContain(setupResponse.status());
  await seedProviderConfig();
}

// Shared login helper: fills the login form and waits for the chat URL.
async function loginAsAdmin(page: Parameters<Parameters<typeof test>[2]>[0]["page"]) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill("admin@test.local");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 10000 });
}

// MockWebSocket is intentionally duplicated across tests rather than shared.
// page.addInitScript() serializes the function to a string for injection into
// the browser context — imports and outer-scope references aren't available.
// Each test gets a slightly different mock behaviour, so the duplication is
// the only practical option without a build step for the init script.

test.describe("chat delivery status and retry E2E", () => {
  // ────────────────────────────────────────────────────────────────────────────
  // Task 5.1 — Happy-path delivery: opacity-60 clears after ack
  // ────────────────────────────────────────────────────────────────────────────
  test("user message shows sending state then clears after ack", async ({ page, request }) => {
    await setupAdmin(request);

    await page.addInitScript(() => {
      type ClientMessage = {
        type?: string;
        clientMessageId?: string;
      };

      const RealWebSocket = window.WebSocket;

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
          queueMicrotask(() => this.onopen?.());
        }

        addEventListener() {}
        removeEventListener() {}

        send(raw: string) {
          const message = JSON.parse(raw) as ClientMessage;

          if (message.type === "history") {
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "history",
                  messages: [{ role: "assistant", content: "How can I help you?" }],
                }),
              });
            }, 0);
            return;
          }

          if (message.type === "message") {
            const clientMessageId = message.clientMessageId;

            // Deliver ack immediately so the message transitions sending → sent
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "ack", clientMessageId }),
              });
            }, 0);

            // Then deliver a chunk and complete the stream
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "chunk",
                  content: "Hello!",
                  messageId: "m1",
                }),
              });
            }, 10);

            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "complete" }),
              });
            }, 20);
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
    });

    await loginAsAdmin(page);

    // Wait for history to load — the welcome screen shows "How can I help you?" once ready
    await expect(page.getByText("How can I help you?")).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Message input").fill("hello");
    await page.getByRole("button", { name: "Send message" }).click();

    // After the ack arrives the opacity-60 class must be gone from the user bubble
    const userBubble = page
      .locator('[data-role="user"]')
      .locator(".aui-user-message-content-wrapper");
    await expect(userBubble).not.toHaveClass(/opacity-60/, { timeout: 5000 });

    // Sanity check: the assistant reply is also rendered (last bubble, greeting is first)
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("Hello!", {
      timeout: 5000,
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 5.2 — Orphan bubble: no assistant response after ack + complete
  // ────────────────────────────────────────────────────────────────────────────
  test("orphan error bubble appears when last message has no assistant response", async ({
    page,
    request,
  }) => {
    await setupAdmin(request);

    await page.addInitScript(() => {
      type ClientMessage = {
        type?: string;
        clientMessageId?: string;
      };

      const RealWebSocket = window.WebSocket;

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
          queueMicrotask(() => this.onopen?.());
        }

        addEventListener() {}
        removeEventListener() {}

        send(raw: string) {
          const message = JSON.parse(raw) as ClientMessage;

          if (message.type === "history") {
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "history",
                  messages: [{ role: "assistant", content: "How can I help you?" }],
                }),
              });
            }, 0);
            return;
          }

          if (message.type === "message") {
            const clientMessageId = message.clientMessageId;

            // Ack the message (it was persisted) …
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "ack", clientMessageId }),
              });
            }, 0);

            // … but the agent never responds — send complete with no chunks.
            // This triggers isOrphaned: last message is user with status "sent",
            // isRunning=false, isHistoryLoaded=true.
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "complete" }),
              });
            }, 10);
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
    });

    await loginAsAdmin(page);

    // Wait for history to load — the welcome screen shows "How can I help you?" once ready
    await expect(page.getByText("How can I help you?")).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Message input").fill("hello");
    await page.getByRole("button", { name: "Send message" }).click();

    // The synthetic orphan bubble must appear — "The agent didn't respond."
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      "The agent didn't respond.",
      { timeout: 5000 }
    );

    // The Retry button must be visible on the orphan bubble
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 5000 });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 5.3 — Partial-stream disconnect: text preserved + Retry button appears
  //
  // Design: the mock fires ack + chunk automatically, but Playwright controls
  // when the disconnect happens — only after "Partial response..." is confirmed
  // visible. This eliminates the timer-ordering race that made previous
  // versions flaky in CI (a delayed 50ms chunk timer firing after the 300ms
  // disconnect timer would invert message order, hiding the partial text as
  // .first() and placing the error bubble first instead).
  //
  // Reconnect prevention: the mock ignores history requests after the first
  // one, so reconnect connections never trigger the history-reconcile path
  // that would wipe the partial + error messages from local state.
  // ────────────────────────────────────────────────────────────────────────────
  test("partial stream preserved and Retry appears after disconnect", async ({ page, request }) => {
    await setupAdmin(request);

    await page.addInitScript(() => {
      // Tracks whether the initial history response has been sent. Subsequent
      // history requests (from reconnect connections) are intentionally ignored
      // so the history-reconcile path never clears the partial + error state.
      let historyResponded = false;

      const RealWebSocket = window.WebSocket;

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
          // All connections open normally. Each connection updates the global
          // trigger so Playwright always disconnects the currently active one.
          queueMicrotask(() => {
            (window as unknown as Record<string, unknown>).__triggerDisconnect = () => {
              this.readyState = 3;
              this.onclose?.();
            };
            this.onopen?.();
          });
        }

        addEventListener() {}
        removeEventListener() {}

        send(raw: string) {
          const message = JSON.parse(raw) as { type?: string; clientMessageId?: string };

          if (message.type === "history") {
            if (!historyResponded) {
              historyResponded = true;
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "history",
                    messages: [{ role: "assistant", content: "How can I help you?" }],
                  }),
                });
              }, 0);
            }
            // Reconnect history requests are ignored — prevents reconcile from
            // clearing partial + error messages.
            return;
          }

          if (message.type === "message") {
            const clientMessageId = message.clientMessageId;
            // Ack immediately, then deliver the partial chunk.
            // No automatic disconnect timer — Playwright drives timing.
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "ack", clientMessageId }),
              });
            }, 0);
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "chunk",
                  content: "Partial response...",
                  messageId: "m1",
                }),
              });
            }, 50);
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
    });

    await loginAsAdmin(page);

    // Wait for history to load — the welcome screen shows "How can I help you?" once ready
    await expect(page.getByText("How can I help you?")).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Message input").fill("hello");
    await page.getByRole("button", { name: "Send message" }).click();

    // Confirm the partial response is visible before triggering the disconnect.
    // This proves the chunk was received and rendered — eliminating the timer-race
    // risk of the previous approach where disconnect could fire before the chunk.
    // nth(1) because nth(0) is now the greeting bubble from history.
    await expect(page.locator('[data-role="assistant"]').nth(1)).toContainText(
      "Partial response...",
      { timeout: 5000 }
    );

    // Now trigger the mid-stream disconnect from Playwright — fully deterministic.
    await page.evaluate(() =>
      (window as unknown as Record<string, () => void>).__triggerDisconnect?.()
    );

    // A disconnect error bubble must appear after the partial response
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("Connection lost", {
      timeout: 5000,
    });

    // The Retry button must be visible on the error bubble
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 5000 });
  });
});

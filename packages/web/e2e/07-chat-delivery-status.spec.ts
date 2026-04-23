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
                data: JSON.stringify({ type: "history", messages: [] }),
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

    // Sanity check: the assistant reply is also rendered
    await expect(page.locator('[data-role="assistant"]')).toContainText("Hello!", {
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
            // Always return empty history
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "history", messages: [] }),
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
    await expect(page.locator('[data-role="assistant"]')).toContainText(
      "The agent didn't respond.",
      { timeout: 5000 }
    );

    // The Retry button must be visible on the orphan bubble
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 5000 });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 5.3 — Partial-stream disconnect: text preserved + Retry button appears
  // ────────────────────────────────────────────────────────────────────────────
  test("partial stream preserved and Retry appears after disconnect", async ({ page, request }) => {
    await setupAdmin(request);

    await page.addInitScript(() => {
      type ClientMessage = {
        type?: string;
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

        // Track which connection this is — reconnects are refused so partial
        // state is preserved for assertion.
        private connectionIndex: number = 0;
        static connectionCount = 0;

        constructor(url: string) {
          if (url.includes("/_next/")) {
            return new RealWebSocket(url) as unknown as MockWebSocket;
          }
          MockWebSocket.connectionCount += 1;
          this.connectionIndex = MockWebSocket.connectionCount;
          if (this.connectionIndex === 1) {
            // First connection opens normally
            queueMicrotask(() => this.onopen?.());
          } else {
            // Subsequent reconnect attempts close immediately — keeps partial
            // state intact so we can assert it without the history reconcile
            // running and wiping the local messages.
            queueMicrotask(() => {
              this.readyState = 3;
              this.onclose?.();
            });
          }
        }

        addEventListener() {}
        removeEventListener() {}

        send(raw: string) {
          const message = JSON.parse(raw) as ClientMessage;

          if (message.type === "history") {
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "history", messages: [] }),
              });
            }, 0);
            return;
          }

          if (message.type === "message") {
            const clientMessageId = (message as { clientMessageId?: string }).clientMessageId;
            // Ack first (matching real protocol), then a partial chunk, then disconnect
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
            // Simulate mid-stream disconnect after chunk — gap must be large enough
            // for React to commit the chunk render and flush the useEffect that
            // updates the assistant-ui runtime before the disconnect arrives.
            setTimeout(() => {
              this.readyState = 3;
              this.onclose?.();
            }, 300);
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

    // The partial assistant text must be visible in the thread
    await expect(page.locator('[data-role="assistant"]').first()).toContainText(
      "Partial response...",
      { timeout: 5000 }
    );

    // A disconnect error bubble must appear below the partial response
    await expect(page.locator('[data-role="assistant"]').last()).toContainText("Connection lost", {
      timeout: 5000,
    });

    // The Retry button must be visible on the error bubble
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 5000 });
  });
});

// packages/web/e2e/integration/upload-protocol-outdated.spec.ts
//
// Verifies that when the Pinchy WS bridge sends an error frame with
// code: "PROTOCOL_OUTDATED", the chat UI shows a persistent toast containing
// "reload" text and a "Reload" action button.
//
// The PROTOCOL_OUTDATED frame is sent by client-router.ts when the client
// submits a message whose content array contains legacy image_url parts
// (the old attachment protocol, removed in favour of the two-phase upload path).
// Any browser client still on the old code should be prompted to reload.
//
// Mock WebSocket strategy (same as 15-model-error-ux.spec.ts):
//   - page.addInitScript() injects a MockWebSocket that intercepts the Pinchy
//     WS connection BEFORE the page hydrates.
//   - History request → empty history + openclaw_status=true so the chat
//     reaches "ready" state without a real OpenClaw connection.
//   - Message send → immediately respond with { type: "error", code: "PROTOCOL_OUTDATED" }.
//   - Next.js /_next/ sockets are forwarded to the real WebSocket so HMR works.
//
// This test does NOT need the Docker integration stack to emit a real
// PROTOCOL_OUTDATED frame — it only exercises the client-side toast rendering.
// The server-side behaviour is covered by the unit test in
//   packages/web/src/__tests__/server/ws-protocol-outdated.test.ts

import { test, expect } from "@playwright/test";

test.describe("PROTOCOL_OUTDATED toast", () => {
  test("legacy WS error frame triggers a reload toast with a Reload button", async ({ page }) => {
    // ── 1. Setup: register admin (idempotent) ──────────────────────────────────
    const setupRes = await page.request.post("/api/setup", {
      data: {
        name: "Integration Admin",
        email: "admin@integration.local",
        password: "integration-password-123",
      },
    });
    expect([201, 403]).toContain(setupRes.status());

    // ── 2. Login so we have a session cookie ──────────────────────────────────
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@integration.local");
    await page.getByLabel("Password", { exact: true }).fill("integration-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // Extract agentId from the redirect URL so we can scope the mock WS.
    const chatUrl = page.url();
    const agentIdMatch = chatUrl.match(/\/chat\/([^/?#]+)/);
    expect(agentIdMatch).toBeTruthy();
    const agentId = agentIdMatch![1];

    // ── 3. Inject MockWebSocket BEFORE navigating to the chat page ────────────
    //    page.addInitScript serialises the callback to a string — no imports or
    //    outer-scope references are available inside the browser context.
    await page.addInitScript(
      ({ targetAgentId }: { targetAgentId: string }) => {
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
            // Forward Next.js HMR/dev sockets to the real WebSocket implementation.
            if (url.includes("/_next/")) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            // Forward connections that are not the chat WS for the agent under test.
            if (!url.includes(targetAgentId)) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            // Fire onopen asynchronously so React has finished subscribing.
            queueMicrotask(() => this.onopen?.());
          }

          addEventListener() {
            // No-op: avoids TypeErrors from dev-tooling that uses addEventListener
            // instead of the onXxx properties.
          }

          removeEventListener() {
            // No-op
          }

          send(raw: string) {
            const message = JSON.parse(raw) as ClientMessage;

            if (message.type === "history") {
              // Respond with empty history + openclaw_status connected so the
              // chat transitions to "ready" state without a real OpenClaw connection.
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "openclaw_status", connected: true }),
                });
              }, 0);
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "history",
                    messages: [],
                    // sessionKnown: true makes knownEmptyHistory=true in useWsRuntime
                    // so chatStatus transitions to "ready" and the Send button enables.
                    sessionKnown: true,
                  }),
                });
              }, 5);
              return;
            }

            if (message.type === "message") {
              const clientMessageId = message.clientMessageId;

              // Ack the user message first so it transitions from "sending" to "sent".
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "ack", clientMessageId }),
                });
              }, 0);

              // Immediately send back a PROTOCOL_OUTDATED error frame.
              // This is exactly the frame client-router.ts emits when it detects
              // a legacy image_url content part in the incoming message.
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "error", code: "PROTOCOL_OUTDATED" }),
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
      },
      { targetAgentId: agentId }
    );

    // ── 4. Navigate to the chat page (mock WS is now installed) ──────────────
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // Wait for the message input to become enabled — confirms chatStatus="ready".
    const input = page.getByLabel("Message input");
    await expect(input).toBeVisible({ timeout: 15000 });

    // ── 5. Send a message — the mock WS responds with PROTOCOL_OUTDATED ───────
    await input.fill("Hello, are you there?");
    await page.getByRole("button", { name: "Send message" }).click();

    // ── 6. Assert toast with "reload" text appears ────────────────────────────
    // use-ws-runtime.ts calls:
    //   toast("Protocol outdated. Please reload the page.", {
    //     description: "Your client is using an old message format.",
    //     action: { label: "Reload", onClick: () => window.location.reload() },
    //     duration: Infinity,
    //   })
    // Sonner renders the toast message in a <div> with role="status" (or similar).
    // We match on case-insensitive "reload" text in the toast region.
    const toastWithReload = page.locator("[data-sonner-toast]").filter({
      hasText: /reload/i,
    });
    await expect(toastWithReload).toBeVisible({ timeout: 10000 });

    // ── 7. Assert the "Reload" action button is present inside the toast ──────
    const reloadButton = toastWithReload.getByRole("button", { name: /reload/i });
    await expect(reloadButton).toBeVisible({ timeout: 5000 });
  });
});

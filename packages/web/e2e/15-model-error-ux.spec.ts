/**
 * Model-unavailable UX test — Issue #305.
 *
 * Verifies that when the server sends an `error` frame with a `modelUnavailable`
 * payload (produced by client-router.ts when OpenClaw returns an upstream 5xx),
 * the chat UI renders the structured "model unavailable" bubble correctly:
 *
 *   1. The headline contains "couldn't respond"
 *   2. A "Switch model →" link pointing to the agent's model settings is visible
 *   3. Clicking "Technical details" reveals the raw provider error string
 *   4. (Optional) The settings deep link navigates to the correct URL
 *
 * Mock WebSocket strategy:
 *   - Uses page.addInitScript() to inject a MockWebSocket before the page loads
 *   - The Pinchy client connects to `/api/ws?agentId=<id>` — the mock intercepts
 *     this URL and replaces it with a controlled implementation
 *   - Next.js dev tooling sockets (/_next/ prefix) are forwarded to the real
 *     WebSocket so HMR/hydration isn't broken
 *   - On receiving the client's `history` request, the mock responds with an
 *     empty history and openclaw_status=true
 *   - On receiving the client's `message` request, the mock immediately sends an
 *     `error` frame with a synthetic modelUnavailable payload, matching exactly
 *     what client-router.ts produces for an upstream 5xx
 *
 * MockWebSocket is intentionally not shared from a helper module — page.addInitScript()
 * serializes the function to a string for injection into the browser context,
 * so imports and outer-scope references are not available inside the callback.
 */

import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

const MODEL_ID = "ollama-cloud/deepseek-v4-pro";
const PROVIDER_ERROR = 'HTTP 500: "Internal Server Error (ref: e2e-model-error-1)"';
const ERROR_REF = "e2e-model-error-1";
const AGENT_NAME = "Smithers";

test.describe("model-unavailable error UX", () => {
  test("structured bubble shows headline, switch-model link, and technical details", async ({
    page,
    request,
  }) => {
    // ── 1. Setup: register admin + seed provider config (idempotent) ──────────
    const setupRes = await request.post("/api/setup", {
      data: {
        name: "Test Admin",
        email: "admin@test.local",
        password: "test-password-123",
      },
    });
    expect([201, 403]).toContain(setupRes.status());

    await seedProviderConfig();

    // ── 2. Fetch the default agent id so we can build the correct WS URL ─────
    //    We do this via page.request so the session cookie is included.
    //    addInitScript runs before the page navigates, but we need the agentId
    //    injected into the mock *before* the WS connection is attempted.
    //    Strategy: do a quick login via the auth API first to get a session
    //    cookie, fetch the agents list, then inject the init script, then
    //    navigate to the chat page.
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // Extract agentId from the URL that we were redirected to
    const chatUrl = page.url();
    const agentIdMatch = chatUrl.match(/\/chat\/([^/?#]+)/);
    expect(agentIdMatch).toBeTruthy();
    const agentId = agentIdMatch![1];

    // ── 3. Inject mock WebSocket *before* navigating to the chat page ─────────
    //    We must call addInitScript before page.goto so the mock is in place
    //    when the React component mounts and calls `new WebSocket(...)`.
    await page.addInitScript(
      ({
        targetAgentId,
        modelId,
        providerError,
        errorRef,
        agentName,
      }: {
        targetAgentId: string;
        modelId: string;
        providerError: string;
        errorRef: string;
        agentName: string;
      }) => {
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
            // Forward Next.js HMR/dev sockets to the real WebSocket
            if (url.includes("/_next/")) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            // Forward connections to any agent other than the one under test
            if (!url.includes(targetAgentId)) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            queueMicrotask(() => this.onopen?.());
          }

          addEventListener() {
            // No-op: avoids TypeErrors from dev-tooling code that subscribes
            // via addEventListener rather than the onXxx properties.
          }

          removeEventListener() {
            // No-op
          }

          send(raw: string) {
            const message = JSON.parse(raw) as ClientMessage;

            if (message.type === "history") {
              // Respond with empty history + openclaw_status connected so the
              // chat considers itself fully ready without waiting for real OpenClaw.
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "openclaw_status",
                    connected: true,
                  }),
                });
              }, 0);
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "history",
                    messages: [],
                    sessionKnown: false,
                  }),
                });
              }, 5);
              return;
            }

            if (message.type === "message") {
              const clientMessageId = message.clientMessageId;

              // Ack the user message so it transitions from "sending" to "sent"
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "ack", clientMessageId }),
                });
              }, 0);

              // Inject the model-unavailable error frame matching exactly what
              // client-router.ts emits for an upstream 5xx from OpenClaw.
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "error",
                    agentName: agentName,
                    providerError: providerError,
                    modelUnavailable: {
                      kind: "model_unavailable",
                      model: modelId,
                      httpStatus: 500,
                      ref: errorRef,
                    },
                    messageId: "e2e-error-msg-1",
                  }),
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
      {
        targetAgentId: agentId,
        modelId: MODEL_ID,
        providerError: PROVIDER_ERROR,
        errorRef: ERROR_REF,
        agentName: AGENT_NAME,
      }
    );

    // ── 4. Navigate to the chat page (mock WS is now installed) ──────────────
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // Wait for the input to appear — confirms the chat is mounted and ready
    const input = page.getByLabel("Message input");
    await expect(input).toBeVisible({ timeout: 10000 });

    // ── 5. Send a message — the mock will respond with the error frame ────────
    await input.fill("Hello, are you there?");
    await page.getByRole("button", { name: "Send message" }).click();

    // ── 6. Assertions ─────────────────────────────────────────────────────────

    // 6a. Error bubble headline: "{agentName} couldn't respond"
    const errorBubble = page.locator('[role="alert"]');
    await expect(errorBubble).toBeVisible({ timeout: 10000 });
    await expect(errorBubble).toContainText("couldn't respond");

    // 6b. "Switch model →" link must be visible and point to the model settings
    const switchModelLink = page.getByRole("link", { name: /switch model/i });
    await expect(switchModelLink).toBeVisible({ timeout: 5000 });
    const href = await switchModelLink.getAttribute("href");
    expect(href).toBe(`/chat/${agentId}/settings?tab=general#model`);

    // 6c. "Technical details" collapsible is present but collapsed
    const technicalDetailsButton = page.getByRole("button", { name: /technical details/i });
    await expect(technicalDetailsButton).toBeVisible({ timeout: 5000 });

    // Before clicking: providerError text is NOT visible
    await expect(page.getByText("HTTP 500")).not.toBeVisible();

    // 6d. Click "Technical details" — the collapsible opens and shows the raw error
    await technicalDetailsButton.click();
    await expect(page.getByText(/HTTP 500/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(new RegExp(ERROR_REF))).toBeVisible();

    // 6e. (Optional) Click "Switch model →" and verify navigation to settings
    await switchModelLink.click();
    await expect(page).toHaveURL(/\/settings\?tab=general#model/, { timeout: 10000 });
  });
});

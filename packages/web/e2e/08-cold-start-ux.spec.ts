/**
 * Visual cold-start UX test — Phase 6.2.
 *
 * Verifies that the connection indicator follows the correct sequence during a
 * cold browser open to the chat page:
 *
 *   1. Immediately shows "Starting..." (yellow) — WS not yet open, no history
 *   2. Transitions to "Connected" (green) once WS opens, openclaw_status=true
 *      arrives, and history loads
 *   3. NEVER flashes red ("Reconnecting...") during the transition
 *
 * This test guards against a regression class where brief `isOpenClawConnected=false`
 * windows during startup triggered the 2s hysteresis timer early, causing
 * the indicator to turn red before going green — confusing users who just
 * opened the app.
 *
 * Architecture after Phase 4.2: OpenClaw is already fully up before Pinchy
 * starts accepting WebSocket connections. The "starting" phase is therefore
 * brief and should never oscillate through red.
 *
 * Mock WebSocket strategy:
 *   - Delays `onopen` by 100ms to simulate a realistic WS handshake
 *   - On receiving the client's `history` request, sends `openclaw_status: true`
 *     followed immediately by a history response
 *   - This keeps the total connection time well within the 2s hysteresis window,
 *     so the indicator must go starting → ready without ever hitting disconnected
 */

import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

test.describe("cold-start UX — indicator sequence", () => {
  test("indicator shows Starting → Connected without red flash", async ({ page, request }) => {
    test.setTimeout(30000);

    const setupResponse = await request.post("/api/setup", {
      data: {
        name: "Test Admin",
        email: "admin@test.local",
        password: "test-password-123",
      },
    });
    expect([201, 403]).toContain(setupResponse.status());

    await seedProviderConfig();

    // Track whether the red "Reconnecting..." state ever appeared.
    // We inject a MutationObserver before page load so it catches even a
    // brief flash that would otherwise be invisible to a poll-based check.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__coldStartRedFlash = false;

      const observer = new MutationObserver(() => {
        const btn = document.querySelector('button[aria-label="Reconnecting..."]');
        if (btn) {
          (window as unknown as Record<string, unknown>).__coldStartRedFlash = true;
        }
      });

      // Observe the full document so we catch the button whenever it is inserted
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      });
    });

    // Mock WebSocket: controls the connection sequence to reproduce cold-start
    await page.addInitScript(() => {
      type ClientMessage = { type?: string; agentId?: string };

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
        readyState = 0; // CONNECTING initially
        binaryType: string = "blob";

        constructor(url: string) {
          if (url.includes("/_next/")) {
            return new RealWebSocket(url) as unknown as MockWebSocket;
          }

          // Simulate a 100ms WS handshake — realistic but well within the 2s hysteresis
          setTimeout(() => {
            this.readyState = 1; // OPEN
            this.onopen?.();
          }, 100);
        }

        addEventListener() {
          // No-op: avoids TypeErrors from dev-tooling event listeners
        }

        removeEventListener() {
          // No-op
        }

        send(raw: string) {
          const message = JSON.parse(raw) as ClientMessage;

          if (message.type === "history") {
            // Immediately tell the client OpenClaw is connected, then deliver history.
            // Both arrive within the 2s hysteresis window → indicator must not go red.
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({ type: "openclaw_status", connected: true }),
              });
              this.onmessage?.({
                data: JSON.stringify({
                  type: "history",
                  messages: [{ role: "assistant", content: "Hello! How can I help you today?" }],
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

    // Login — MutationObserver starts watching after DOMContentLoaded
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/chat\//, { timeout: 10000 });

    // 1. Immediately after navigation: indicator must show "Starting..." (yellow).
    //    The WS hasn't opened yet (100ms delay). Check within 50ms of navigation.
    await expect(page.getByRole("button", { name: "Starting..." })).toBeVisible({
      timeout: 2000,
    });

    // 2. Wait for history to load and indicator to become "Connected" (green).
    await expect(page.getByText("Hello! How can I help you today?")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({
      timeout: 5000,
    });

    // 3. The red "Reconnecting..." state must never have appeared.
    const redFlashed = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__coldStartRedFlash
    );
    expect(redFlashed, "Indicator flashed red during cold-start — hysteresis regression").toBe(
      false
    );
  });
});

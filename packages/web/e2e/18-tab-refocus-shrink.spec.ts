// packages/web/e2e/18-tab-refocus-shrink.spec.ts
//
// Real-browser regression guard for the intermittent tab-refocus crash (#510)
// `tapClientLookup: Index N out of bounds (length: N)` ("Something went wrong").
//
// This crash survived BOTH earlier fixes (v0.5.7 in-flight anchor, v0.5.8 own
// in-flight placeholder). Root cause: assistant-ui renders
// `thread.messages.length` message components keyed by INDEX, each reading
// `aui.thread().message({ index }).getState()`. If `messages.length` SHRINKS
// while <ThreadPrimitive.Messages> is mounted, a trailing-index child re-renders
// (via its own store subscription) before React unmounts it and reads
// `tapClientLookup.get({ index })` out of bounds — throwing into the chat error
// boundary. jsdom renders synchronously and can't show this race; only a real
// browser can (this spec is authoritative; the proximate invariant is also
// pinned by use-ws-runtime-refocus-shrink.test.tsx).
//
// Trigger: a tab refocus reconnects and re-requests history. Mid-run the server
// can return a history SHORTER than the rich local list together with an
// `activeRun` signal (the in-flight reply isn't persisted yet, or OpenClaw
// history is transiently empty during a restart — see client-router.ts
// handleHistory, the `{ messages: [], sessionKnown: true, activeRun }` branch).
// The destructive-reconcile unmount gate (isReconcilingMessages) is skipped when
// an activeRun is present, so pre-fix the shorter list is applied synchronously
// and the message list shrinks while mounted → crash.
//
// The WebSocket is fully mocked client-side so the exact server frame sequence
// is deterministic (same technique as 04-chat-reconnect.spec.ts).
import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

const HISTORY_MESSAGES = [
  { role: "user", content: "refocus turn one" },
  { role: "assistant", content: "reply one" },
  { role: "user", content: "refocus turn two" },
  { role: "assistant", content: "reply two" },
  { role: "user", content: "refocus turn three" },
  { role: "assistant", content: "reply three" },
  { role: "user", content: "refocus turn four" },
  { role: "assistant", content: "reply four" },
];

test.describe("tab refocus reconcile", () => {
  test("refocus with a shorter history + activeRun must not crash the chat view", async ({
    page,
    request,
  }) => {
    const setupResponse = await request.post("/api/setup", {
      data: { name: "Test Admin", email: "admin@test.local", password: "test-password-123" },
    });
    expect([201, 403]).toContain(setupResponse.status());

    await seedProviderConfig();

    await page.addInitScript((historyMessages) => {
      type ClientMessage = { type?: string };
      const globalState = { historyRequests: 0 };
      const RealWebSocket = window.WebSocket;

      // Let the test drive the page-visibility lifecycle deterministically.
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      (window as unknown as { __setVisibility: (v: string) => void }).__setVisibility = (v) => {
        visibility = v;
        document.dispatchEvent(new Event("visibilitychange"));
      };

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
        binaryType = "blob";
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
            globalState.historyRequests += 1;
            const payload =
              globalState.historyRequests === 1
                ? // Initial load: a rich, multi-message conversation. This mounts
                  // one assistant-ui message component per message (keyed by index).
                  { type: "history", messages: historyMessages }
                : // Recovery after refocus: OpenClaw history is transiently empty
                  // but the run is still active — the exact frame that shrinks the
                  // list under the activeRun path.
                  {
                    type: "history",
                    messages: [],
                    sessionKnown: true,
                    activeRun: {
                      runId: "run-refocus",
                      messageId: "srv-refocus",
                      startedAt: 1000,
                      partialContent: "",
                    },
                  };
            setTimeout(() => this.onmessage?.({ data: JSON.stringify(payload) }), 0);
            return;
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
    }, HISTORY_MESSAGES);

    // Surface any uncaught page error in the test output for diagnosis.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Sign in via the auth API rather than the login form. The form's onSubmit
    // races React hydration on a cold server's first compile (the click beats
    // the handler, the browser does a native GET submit, and the page is
    // stranded on /login?email=…&password=…) — pure test-infra flake unrelated
    // to this regression. The API path is deterministic; page.request shares the
    // page's cookie jar (same technique as the switchUser helper), so the
    // session applies to the subsequent navigation.
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: "admin@test.local", password: "test-password-123" },
      headers: { "Content-Type": "application/json" },
    });
    expect(signIn.ok()).toBeTruthy();
    const agents = (await (await page.request.get("/api/agents")).json()) as { id: string }[];
    expect(agents.length).toBeGreaterThan(0);
    await page.goto(`/chat/${agents[0]!.id}`);
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // The full conversation is rendered: 4 assistant bubbles + 4 user bubbles.
    const assistantBubbles = page.locator('[data-role="assistant"]');
    await expect(assistantBubbles).toHaveCount(4, { timeout: 15000 });
    await expect(page.getByText("reply four")).toBeVisible();

    // Tab backgrounded, then refocused — drops the WS and re-requests history.
    await page.evaluate(() => {
      (window as unknown as { __setVisibility: (v: string) => void }).__setVisibility("hidden");
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      (window as unknown as { __setVisibility: (v: string) => void }).__setVisibility("visible");
    });

    // Give the recovery history + activeRun reconcile time to land (and crash,
    // pre-fix). A short settle is enough — the reconcile is synchronous.
    await page.waitForTimeout(1000);

    // The error boundary must NOT have replaced the chat view.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    expect(
      pageErrors.find((m) => m.includes("tapClientLookup") || m.includes("out of bounds")),
      `page threw: ${pageErrors.join(" | ")}`
    ).toBeUndefined();

    // The locally-known conversation is preserved (not shrunk away), and the
    // composer is still interactive — a crashed view would have neither.
    await expect(assistantBubbles.count()).resolves.toBeGreaterThanOrEqual(4);
    await expect(page.getByText("reply four")).toBeVisible();
  });
});

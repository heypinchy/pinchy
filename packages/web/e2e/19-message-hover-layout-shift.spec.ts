// packages/web/e2e/19-message-hover-layout-shift.spec.ts
//
// Real-browser regression guard for the message layout shift: assistant messages
// changed height by 8px depending on whether their action bar was mounted, so
// messages jumped whenever the bar appeared or disappeared.
//
// Root cause: assistant-ui UNMOUNTS the action bar rather than hiding it with
// CSS (`ActionBarRoot` returns null), and `autohide="not-last"` means the bar is
// mounted IN FLOW (`normal`, position: static) on the last message but absent on
// every other one. The footer row therefore measured 24px (button height, size-6)
// on the last message and only 16px (timestamp line-height, text-xs) elsewhere.
// Every isLast handover — a new reply arriving, a run finishing (hideWhenRunning)
// — resized a message by 8px and shifted the view. The fix reserves the bar's
// height on every footer row (min-h-6 in thread.tsx), making all messages equal.
//
// Measured in Chromium before the fix: non-last message 68px / footer 16px,
// last message 76px / footer 24px.
//
// This spec is authoritative and jsdom cannot replace it: the bug IS layout, and
// jsdom has no layout engine — every element there reports height 0. The unit
// test in thread.test.tsx can only assert the class is present, which stays green
// if TooltipIconButton's size-6 ever grows. Only a real browser measures the
// actual shift.
//
// The WebSocket is fully mocked client-side so the conversation is deterministic
// and no OpenClaw stack is needed (same technique as 04-chat-reconnect.spec.ts
// and 18-tab-refocus-shrink.spec.ts).
import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

// Timestamps matter: MessageTimestamp only renders when metadata.custom.timestamp
// is set, and its text-xs line-height is exactly the 16px the bar-less rows had.
// The two assistant replies are the same length so their content wraps identically
// and any height difference can only come from the footer.
const HISTORY_MESSAGES = [
  { role: "user", content: "layout turn one", timestamp: "2026-07-15T09:39:00.000Z" },
  { role: "assistant", content: "reply alpha", timestamp: "2026-07-15T09:39:01.000Z" },
  { role: "user", content: "layout turn two", timestamp: "2026-07-15T09:39:02.000Z" },
  { role: "assistant", content: "reply bravo", timestamp: "2026-07-15T09:39:03.000Z" },
];

const mockHistorySocket = (historyMessages: typeof HISTORY_MESSAGES) => {
  type ClientMessage = { type?: string };
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
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "history", messages: historyMessages }),
          });
        }, 0);
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
};

test.describe("message action-bar layout shift", () => {
  test.beforeEach(async ({ page, request }) => {
    const setupResponse = await request.post("/api/setup", {
      data: { name: "Test Admin", email: "admin@test.local", password: "test-password-123" },
    });
    expect([201, 403]).toContain(setupResponse.status());

    await seedProviderConfig();
    await page.addInitScript(mockHistorySocket, HISTORY_MESSAGES);

    // Sign in via the auth API rather than the login form — the form's onSubmit
    // races hydration on a cold server's first compile (see the same note in
    // 18-tab-refocus-shrink.spec.ts).
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: "admin@test.local", password: "test-password-123" },
      headers: { "Content-Type": "application/json" },
    });
    expect(signIn.ok()).toBeTruthy();
    const agents = (await (await page.request.get("/api/agents")).json()) as { id: string }[];
    expect(agents.length).toBeGreaterThan(0);
    await page.goto(`/chat/${agents[0]!.id}`);
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(2, { timeout: 15000 });
  });

  // THE regression test for the fix. assistant-ui mounts the bar in flow on the
  // last message only, so without a reserved height the last message is 8px
  // taller than the rest — and every message shrinks by 8px the moment it stops
  // being last (i.e. whenever the next reply arrives).
  test("a message must not change height when it stops being the last one", async ({ page }) => {
    const assistantMessages = page.locator('[data-role="assistant"]');
    const nonLast = assistantMessages.first();
    const last = assistantMessages.nth(1);

    // The bar is mounted in flow on the last message and absent on the other —
    // that asymmetry is exactly what the reserved height has to absorb. Assert it
    // so this test fails loudly if assistant-ui ever changes the autohide model,
    // rather than passing for the wrong reason.
    await expect(last.locator(".aui-assistant-action-bar-root")).toBeVisible();
    await expect(nonLast.locator(".aui-assistant-action-bar-root")).toHaveCount(0);

    const footerHeight = (locator: typeof nonLast) =>
      locator
        .locator(".aui-assistant-message-footer")
        .boundingBox()
        .then((box) => box!.height);

    expect(
      await footerHeight(nonLast),
      "footer row of a non-last message must already reserve the action bar's height"
    ).toBe(await footerHeight(last));

    const nonLastBox = (await nonLast.boundingBox())!;
    const lastBox = (await last.boundingBox())!;
    expect(
      Math.abs(nonLastBox.height - lastBox.height),
      `messages differ in height (${nonLastBox.height}px vs ${lastBox.height}px), so the view jumps when the last-message bar mounts or unmounts`
    ).toBeLessThan(1);
  });

  // Guards the floating mechanism itself: a hovered non-last message gets the bar
  // back as an absolutely-positioned overlay (data-floating → data-floating:absolute).
  // If those utilities ever stop applying, the bar lands in flow and hovering
  // starts pushing the conversation around — the symptom originally reported.
  test("hovering a non-last message must not move the messages below it", async ({ page }) => {
    const assistantMessages = page.locator('[data-role="assistant"]');
    const hoverTarget = assistantMessages.first();
    const messageBelow = page.getByText("layout turn two");

    // Measure the GAP between the two, not their viewport coordinates: hover()
    // scrolls the target into view inside the scrollable thread viewport, which
    // moves absolute positions by a pixel or two for reasons unrelated to layout.
    // The gap is scroll-invariant and is what actually grows when the bar lands
    // in flow.
    const gap = async () => {
      const target = (await hoverTarget.boundingBox())!;
      const below = (await messageBelow.boundingBox())!;
      return below.y - target.y;
    };

    const heightBefore = (await hoverTarget.boundingBox())!.height;
    const gapBefore = await gap();

    await hoverTarget.hover();

    // Wait for the bar to actually mount — otherwise a green result would only
    // prove the hover never registered. The Copy button carries an sr-only
    // "Copy" label (TooltipIconButton), a stable user-facing handle.
    const actionBar = hoverTarget.locator(".aui-assistant-action-bar-root");
    await expect(hoverTarget.getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 5000 });
    await expect(actionBar).toHaveAttribute("data-floating", "true");
    await expect(actionBar).toHaveCSS("position", "absolute");

    const heightAfter = (await hoverTarget.boundingBox())!.height;
    const gapAfter = await gap();

    expect(
      Math.abs(heightAfter - heightBefore),
      `message grew on hover: ${heightBefore}px → ${heightAfter}px`
    ).toBeLessThan(1);
    expect(
      Math.abs(gapAfter - gapBefore),
      `messages below jumped on hover: gap ${gapBefore}px → ${gapAfter}px`
    ).toBeLessThan(1);
  });
});

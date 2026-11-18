// packages/web/e2e/20-diagnostics-export-dialog-overflow.spec.ts
//
// Real-browser regression guard for the diagnostics export dialog overflowing
// on a long chat title: the chat picker and the textarea below it spilled out
// past the dialog's right edge, over the page behind it.
//
// Root cause: shadcn's SelectTrigger is `w-fit` + `whitespace-nowrap`, so it
// sizes to the selected chat's title. DialogContent is a `grid`, and a grid
// column's `auto` track sizes to its items' min-content — which the nowrap
// trigger makes as wide as the whole title. The dialog box itself stayed at
// `sm:max-w-md` while its contents grew past it. The fix is `w-full min-w-0` on
// the trigger, making it shrinkable and letting the title clamp instead.
//
// This spec is authoritative and jsdom cannot replace it: the bug IS layout,
// and jsdom has no layout engine — every element there reports width 0. The
// unit test in diagnostics-export-dialog.test.tsx can only assert the classes
// are present, which stays green if the trigger's defaults or the dialog's
// display mode ever change. Only a real browser measures the actual spill.
//
// Note the inline Settings → Diagnostics surface cannot catch this: its
// container is a block element, where `w-fit` resolves against the available
// width and can never overflow. The grid inside the dialog is the only place
// the bug lives.
//
// The WebSocket is fully mocked client-side so the conversation is
// deterministic and no OpenClaw stack is needed (same technique as
// 19-message-hover-layout-shift.spec.ts), and the chats API is stubbed so the
// long title doesn't depend on a live model turn.
import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "./helpers";

const HISTORY_MESSAGES = [
  { role: "user", content: "export turn one", timestamp: "2026-07-15T09:39:00.000Z" },
  { role: "assistant", content: "reply alpha", timestamp: "2026-07-15T09:39:01.000Z" },
];

// The title that triggered the original report — long enough to blow past the
// dialog's `sm:max-w-md` several times over.
const LONG_TITLE =
  "Sind jetzt alle gebuchten Rechnungen mit Bankbuchungen abgeglichen und verbucht?";

const CHATS = [
  {
    chatId: null,
    sessionId: "s-default",
    origin: "web",
    writable: true,
    title: LONG_TITLE,
    lastInteractionAt: 1000,
  },
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

test.describe("diagnostics export dialog overflow", () => {
  test.beforeEach(async ({ page, request }) => {
    const setupResponse = await request.post("/api/setup", {
      data: { name: "Test Admin", email: "admin@test.local", password: "test-password-123" },
    });
    expect([201, 403]).toContain(setupResponse.status());

    await seedProviderConfig();
    await page.addInitScript(mockHistorySocket, HISTORY_MESSAGES);

    // Force the long-title case: the real title comes from the session's first
    // message, which would need a live model turn.
    await page.route("**/api/agents/*/chats", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ chats: CHATS }),
      })
    );

    // Sign in via the auth API rather than the login form — the form's onSubmit
    // races hydration on a cold server's first compile (see the same note in
    // 19-message-hover-layout-shift.spec.ts).
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: "admin@test.local", password: "test-password-123" },
      headers: { "Content-Type": "application/json" },
    });
    expect(signIn.ok()).toBeTruthy();
    const agents = (await (await page.request.get("/api/agents")).json()) as { id: string }[];
    expect(agents.length).toBeGreaterThan(0);
    await page.goto(`/chat/${agents[0]!.id}`);
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(1, { timeout: 15000 });
  });

  test("a long chat title must not push the picker out of the dialog", async ({ page }) => {
    const lastAssistant = page.locator('[data-role="assistant"]').last();
    await lastAssistant.hover();
    await page.getByTestId("assistant-action-bar-more-trigger").last().click();
    await page.getByTestId("report-issue-menu-item").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const picker = dialog.getByRole("combobox", { name: /chat to export/i });
    await expect(picker).toBeVisible({ timeout: 10000 });

    // Assert the title is actually the long one — otherwise a green result
    // would only prove the stub never applied.
    await expect(picker).toContainText("Sind jetzt alle gebuchten Rechnungen");

    const dialogBox = (await dialog.boundingBox())!;
    const pickerBox = (await picker.boundingBox())!;
    const textarea = dialog.getByPlaceholder(/what went wrong/i);
    const textareaBox = (await textarea.boundingBox())!;

    // Before the fix the trigger measured ~600px against a ~448px dialog and
    // hung out over the page behind it; the textarea stretched to the same
    // over-wide grid column.
    expect(
      pickerBox.x + pickerBox.width,
      `chat picker spills past the dialog: picker ends at ${Math.round(pickerBox.x + pickerBox.width)}px, dialog at ${Math.round(dialogBox.x + dialogBox.width)}px`
    ).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
    expect(
      textareaBox.x + textareaBox.width,
      `description field spills past the dialog: field ends at ${Math.round(textareaBox.x + textareaBox.width)}px, dialog at ${Math.round(dialogBox.x + dialogBox.width)}px`
    ).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);

    // The dialog must not have been stretched instead — the box itself is
    // capped, but pin it so a future `max-w` removal can't turn a spilling
    // picker into a full-width dialog and still pass the assertions above.
    expect(dialogBox.width).toBeLessThanOrEqual(500);
  });
});

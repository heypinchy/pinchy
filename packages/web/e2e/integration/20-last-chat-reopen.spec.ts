import { test, expect } from "@playwright/test";
import { login, getSmithersAgentId } from "./helpers";

// End-to-end guard for "reopen the chat I last had open" (#508).
//
// The unit tests cover each seam (Chat records the last-viewed chat, the sidebar
// resolves the link from localStorage, the default route redirects as a fallback).
// This pins the seams together through real navigation: visit a named chat, leave
// to another page, then the agent's sidebar link must point back to that chat —
// not the bare /chat/<agentId> that lands on the oldest/default chat.
//
// Deliberately OpenClaw-independent: the assertion is purely the resolved link and
// the resulting URL, so there is no streaming/timing flake surface. localStorage is
// written by <Chat> on mount (before it gates on the runtime), so the named chat
// need not have a server session.
test.describe("Reopen last-viewed chat (#508)", () => {
  test("the agent sidebar link returns to the chat last viewed on this device", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const agentId = await getSmithersAgentId(page);

    const namedChatId = "e2e-last-chat";

    // Visit a named chat — <Chat> records it as this agent's last-viewed chat.
    await page.goto(`/chat/${agentId}/${namedChatId}`);
    await expect
      .poll(() => page.evaluate((aid) => localStorage.getItem(`pinchy:lastChat:${aid}`), agentId), {
        timeout: 15000,
      })
      .toBe(namedChatId);

    // Leave to a non-chat page; the sidebar stays mounted in the app layout.
    await page.goto("/usage");

    // The agent's sidebar link must resolve to the last-viewed chat, not the bare
    // /chat/<agentId> (which would land on the oldest/default chat).
    const agentLink = page.locator(`a[href^="/chat/${agentId}"]`).first();
    await expect(agentLink).toHaveAttribute("href", `/chat/${agentId}/${namedChatId}`, {
      timeout: 15000,
    });

    // Clicking it lands on that chat (the named route renders directly, no redirect).
    await agentLink.click();
    await expect(page).toHaveURL((url) => url.pathname === `/chat/${agentId}/${namedChatId}`, {
      timeout: 15000,
    });

    await ctx.close();
  });
});

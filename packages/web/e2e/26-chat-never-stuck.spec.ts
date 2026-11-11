/**
 * The chat never sits on "Reconnecting" with no way out — Issue #1422.
 *
 * Before the fix the client gave up after ten attempts and showed "Please
 * reload", and a server-side connection cap turned that into a loop users could
 * only break by closing tabs. These specs drive the real socket through
 * `page.routeWebSocket` and assert what a user sees:
 *
 *   (a) a refused connection (4429) says why, and "Try again now" recovers;
 *   (b) a dropped socket heals without a reload, and the draft survives;
 *   (c) going offline says so and recovers when the network returns.
 *
 * No fixed sleeps: every wait is an assertion on something the user can see.
 */

import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import { seedProviderConfig } from "./helpers";

async function openChat(page: Page, request: APIRequestContext) {
  const setupRes = await request.post("/api/setup", {
    data: { name: "Test Admin", email: "admin@test.local", password: "test-password-123" },
  });
  expect([201, 403]).toContain(setupRes.status());
  await seedProviderConfig();

  await page.goto("/login");
  await page.getByLabel(/email/i).fill("admin@test.local");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/chat\//, { timeout: 30_000 });
  const agentId = page.url().match(/\/chat\/([^/?#]+)/)![1];
  return agentId;
}

const WS_URL = /\/api\/ws\?agentId=/;

test.describe("chat never stuck on reconnecting (#1422)", () => {
  test("a refused connection says why, and Try again now gets in", async ({ page, request }) => {
    test.setTimeout(120_000);
    const agentId = await openChat(page, request);

    let refuse = true;
    await page.routeWebSocket(WS_URL, (ws) => {
      if (refuse) {
        ws.close({ code: 4429, reason: "too_many_connections" });
        return;
      }
      ws.connectToServer();
    });

    await page.goto(`/chat/${agentId}`);

    const status = page.getByRole("status");
    await expect(status).toContainText(/too many open connections/i, { timeout: 30_000 });
    await expect(status).toContainText(/still trying/i);
    // Not a dead end: no reload demand anywhere.
    await expect(page.getByText(/please reload/i)).toHaveCount(0);

    refuse = false;
    await page.getByRole("button", { name: /try again now/i }).click();
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({ timeout: 30_000 });
    await expect(status).not.toContainText(/too many open connections/i);
  });

  test("a dropped socket heals without a reload and keeps the draft", async ({ page, request }) => {
    test.setTimeout(120_000);
    const agentId = await openChat(page, request);

    const routes: WebSocketRoute[] = [];
    let serverUp = true;
    await page.routeWebSocket(WS_URL, (ws) => {
      if (!serverUp) {
        ws.close({ code: 1013, reason: "restarting" });
        return;
      }
      routes.push(ws);
      ws.connectToServer();
    });

    await page.goto(`/chat/${agentId}`);
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({ timeout: 30_000 });

    const composer = page.getByPlaceholder(/send a message/i);
    await composer.fill("half-written question");

    // The server goes away and every reconnect is refused for a while.
    serverUp = false;
    routes.forEach((ws) => ws.close({ code: 1001, reason: "going away" }));
    await expect(page.getByRole("status")).toContainText(/reconnecting/i, { timeout: 30_000 });

    // It comes back; the client must find it on its own.
    serverUp = true;
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue("half-written question");
  });

  test("going offline says so and recovers when the network returns", async ({
    page,
    request,
    context,
  }) => {
    test.setTimeout(120_000);
    const agentId = await openChat(page, request);

    await page.goto(`/chat/${agentId}`);
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({ timeout: 30_000 });

    await context.setOffline(true);
    await expect(page.getByRole("status")).toContainText(/you're offline/i, { timeout: 15_000 });

    await context.setOffline(false);
    await expect(page.getByRole("button", { name: "Connected" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status")).not.toContainText(/offline/i);
  });
});

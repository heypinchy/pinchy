import { test, expect } from "@playwright/test";
import { loginAsAdmin, seedProviderConfig } from "./helpers";

/**
 * The global "instance is not secured" banner must not appear on a local
 * install. `baseURL` here is `http://localhost:7778`, which is exactly the
 * situation: a browser already treats localhost as a secure context, and there
 * is no domain to lock, so the advice cannot be acted on.
 *
 * This runs against a REAL Next.js server on purpose. The unit tests around
 * `isLoopbackRequest` mock `next/headers`, and the first implementation of this
 * feature passed all of them while doing nothing at all: it read any
 * `x-forwarded-*` header as proof of a proxy, not knowing that Next.js
 * back-fills those headers on every request that lacks them
 * (`base-server.js`). Only a real server carries that back-fill, so only a
 * real server can catch that class of mistake.
 */
test.describe("Insecure-mode banner", () => {
  test("stays hidden on localhost while the instance really is unsecured", async ({ page }) => {
    // Without a configured provider the first login lands on /setup/provider
    // instead of the app shell, and `loginAsAdmin` waits for /chat/.
    await seedProviderConfig();
    await loginAsAdmin(page);

    await page.goto("/settings?tab=security");

    // Precondition, asserted rather than assumed: this instance has no domain
    // locked, so `isInsecureMode()` is true and the banner is genuinely
    // suppressed — not merely absent because there was nothing to warn about.
    // Without this the test would still pass on a locked instance and prove
    // nothing.
    await expect(page.getByText(/your instance is not secured with https/i)).toBeVisible();

    await expect(page.getByTestId("insecure-banner")).toHaveCount(0);
  });
});

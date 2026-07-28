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
 * back-fills those headers on every request that lacks them (`base-server.js`).
 * That version fails here, which is the point of the file.
 *
 * Be precise about what it does and does not prove, though. The unit fixtures
 * now carry the back-filled header themselves, so they cover the two paths
 * (synthesized vs. real `X-Forwarded-Host`) far more sharply than this test can
 * — from here both spell `localhost:7778` and reach the same verdict. What only
 * a real server gives us is that the fixtures' PREMISE stays true: if a Next
 * upgrade ever changes what a request carries by the time a Server Component
 * sees it, the unit suite would keep describing a request that no longer
 * exists, and this test is what notices.
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

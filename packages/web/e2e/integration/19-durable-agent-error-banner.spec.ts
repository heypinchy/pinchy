// packages/web/e2e/integration/19-durable-agent-error-banner.spec.ts
//
// End-to-end guard for the durable agent-error "paused" banner (Concern 1).
//
// When an OpenClaw run errors (here: a provider rate limit, the production
// scenario from the audit log), the live error bubble is ephemeral — a reload
// or a WS reconnect during a long tool loop loses it, leaving only the audit
// row. This spec drives the WHOLE path through the real OpenClaw container:
// fake-ollama returns a 429 → OpenClaw surfaces a transient error chunk →
// Pinchy persists it to chat_session_errors → after a reload the ChatErrorBanner
// re-fetches and re-surfaces it with honest, cause-specific copy. Unit/test:db
// layers restate the chunk shape; only this proves OpenClaw actually emits a
// transient error chunk that the persist path records.
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import {
  FAKE_OLLAMA_RATE_LIMIT_TRIGGER,
  FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TRIGGER,
} from "../shared/fake-ollama/fake-ollama-server";
import { stackDbUrl } from "../shared/stack-db";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

test.describe("Durable agent-error banner", () => {
  // The integration stack is shared and never truncated between specs, and these
  // tests share the Smithers session. Clear durable errors before each test so a
  // prior test's (or run's) un-dismissed error can't mask the one under test.
  test.beforeEach(async () => {
    const sql = postgres(stackDbUrl(5435));
    try {
      await sql`DELETE FROM chat_session_errors`;
    } finally {
      await sql.end();
    }
  });

  test("a transient error re-surfaces as a paused banner after reload and can be dismissed", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    await input.fill(`${FAKE_OLLAMA_RATE_LIMIT_TRIGGER}: please do the thing`);
    await input.press("Enter");

    // The run errors — an inline error bubble renders live (the ephemeral path).
    await expect(page.getByTestId("error-warning-icon").last()).toBeVisible({ timeout: 60000 });

    // Reload: the ephemeral bubble is gone, but the durable banner re-fetches and
    // re-surfaces the error with honest, cause-specific copy.
    await page.reload();
    await waitForOpenClawConnected(page);

    const banner = page.getByText(/Smithers paused/i);
    await expect(banner).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/rate-limiting|temporarily unavailable/i)).toBeVisible();

    // Dismiss clears it server-side, and it stays gone across another reload.
    await page.getByRole("button", { name: /dismiss/i }).click();
    await expect(banner).toHaveCount(0);

    await page.reload();
    await waitForOpenClawConnected(page);
    await expect(page.getByText(/Smithers paused/i)).toHaveCount(0);
  });

  test("a failure after a tool call warns about duplicates and gates retry behind a confirm", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    await input.fill(`${FAKE_OLLAMA_TOOL_THEN_RATE_LIMIT_TRIGGER}: do the thing`);
    await input.press("Enter");

    await expect(page.getByTestId("error-warning-icon").last()).toBeVisible({ timeout: 60000 });

    // In-session (the live path, before any reload): the LIVE error frame
    // carries the audit-derived sideEffects flag, so the inline bubble's Retry
    // is gated behind the SAME duplicate-write confirm as the durable banner —
    // not just the post-reload banner. Clicking it opens the confirm instead of
    // resending. Cancel here so the run's durable error survives to the reload
    // assertions below.
    await page.getByRole("button", { name: /^retry$/i }).click();
    const liveConfirm = page.getByRole("alertdialog");
    await expect(liveConfirm).toBeVisible();
    await expect(liveConfirm).toContainText(/duplicate/i);
    await liveConfirm.getByRole("button", { name: /cancel/i }).click();
    await expect(liveConfirm).toHaveCount(0);

    await page.reload();
    await waitForOpenClawConnected(page);

    await expect(page.getByText(/Smithers paused/i)).toBeVisible({ timeout: 30000 });
    // The run already executed a tool, so the banner warns about duplicate writes.
    await expect(page.getByTestId("side-effects-warning")).toBeVisible();

    // Retry is a secondary action gated behind a duplicate-write confirmation.
    await page.getByRole("button", { name: /^retry$/i }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/duplicate/i);
    await expect(confirm.getByRole("button", { name: /retry anyway/i })).toBeVisible();
  });
});

// packages/web/e2e/integration/diagnostics-export.spec.ts
//
// E2E coverage for the self-service diagnostics export flow.
//
// Two entry points are exercised:
//   1. Settings → Support → Generate (no anchor)
//   2. Per-message action bar → "Report issue to support" → Generate (anchor present)
//
// The test runs against the integration dev stack (docker-compose.integration.yml)
// and uses the fake-ollama mock so chat turns work without a real provider.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { FAKE_OLLAMA_RESPONSE } from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

async function sendChatTurnAndAwaitReply(page: Page, message: string) {
  const input = page.getByPlaceholder(/send a message/i);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(message);
  await input.press("Enter");
  // Chat history from earlier specs (e.g. agent-chat.spec.ts) accumulates on
  // the shared Smithers agent, so FAKE_OLLAMA_RESPONSE can be present multiple
  // times. Anchor on the newest match.
  await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });
}

/**
 * Clicks the dialog's Generate button and asserts that the diagnostics-export
 * API responds 200 before waiting for the download. If the API fails the test
 * surfaces the actual status + body — much more useful than a generic 120s
 * "waiting for download" timeout.
 */
async function clickDialogGenerateAndAwaitDownload(page: Page) {
  const apiResponsePromise = page.waitForResponse(
    (r) => r.url().includes("/api/diagnostics/export") && r.request().method() === "POST",
    { timeout: 60000 }
  );
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.getByRole("button", { name: /^generate$/i }).click();

  const apiResponse = await apiResponsePromise;
  if (apiResponse.status() !== 200) {
    const body = await apiResponse.text().catch(() => "(could not read body)");
    throw new Error(`POST /api/diagnostics/export failed with ${apiResponse.status()}: ${body}`);
  }
  return downloadPromise;
}

test.describe("Self-service diagnostics export", () => {
  test("Settings → Support → Generate produces a downloadable JSON file", async ({ page }) => {
    await login(page);
    await waitForOpenClawConnected(page);

    // Send one chat message so the session JSONL has content for the bundle.
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await sendChatTurnAndAwaitReply(page, "Hello, this is a diagnostic test message");

    // Open Settings → Support.
    await page.goto("/settings?tab=support");
    const openDialogButton = page.getByRole("button", { name: /generate diagnostics export/i });
    await expect(openDialogButton).toBeVisible({ timeout: 10000 });
    await openDialogButton.click();

    // The dialog has a "Generate" button — click it and wait for the download.
    const download = await clickDialogGenerateAndAwaitDownload(page);
    expect(download.suggestedFilename()).toMatch(/^pinchy-bugreport-.+\.json$/);

    // Save and inspect the bundle.
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(downloadPath!, "utf8");
    const content = JSON.parse(raw) as {
      schemaVersion: string;
      spans: unknown[];
      scope: { agentId: string; anchorTurnIndex: number | null };
    };
    expect(content.schemaVersion).toBe("pinchy.bugreport.v1");
    expect(content.spans.length).toBeGreaterThan(0);
    expect(content.scope.agentId).toBe(agentId);
    // No anchor was provided in the Settings flow.
    expect(content.scope.anchorTurnIndex).toBeNull();
  });

  test("Per-message Report issue downloads a bundle (v1 anchor=null limitation)", async ({
    page,
  }) => {
    await login(page);
    await waitForOpenClawConnected(page);

    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await sendChatTurnAndAwaitReply(page, "Diagnostic anchor test");

    // Hover the last assistant message to surface the action bar, then open
    // the More menu. Selectors:
    //   - assistant message wrapper: data-role="assistant" (set on MessagePrimitive.Root)
    //   - More trigger:              data-testid="assistant-action-bar-more-trigger"
    //   - Report-issue menu item:    data-testid="report-issue-menu-item"
    // Both data-testid attributes were added in Task 16 specifically to make
    // this flow reliable; the role/text fallbacks were too ambiguous because
    // assistant-ui renders the trigger only on hover.
    const lastAssistant = page.locator('[data-role="assistant"]').last();
    await lastAssistant.hover();
    await page.getByTestId("assistant-action-bar-more-trigger").last().click();
    await page.getByTestId("report-issue-menu-item").click();

    const download = await clickDialogGenerateAndAwaitDownload(page);
    expect(download.suggestedFilename()).toMatch(/^pinchy-bugreport-.+\.json$/);

    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const fs = await import("node:fs/promises");
    const content = JSON.parse(await fs.readFile(downloadPath!, "utf8")) as {
      schemaVersion: string;
      spans: unknown[];
      scope: { agentId: string; anchorTurnIndex: number | null };
    };
    expect(content.schemaVersion).toBe("pinchy.bugreport.v1");
    expect(content.spans.length).toBeGreaterThan(0);
    expect(content.scope.agentId).toBe(agentId);

    // V1 limitation: the scope-resolver parses `anchorMessageId` as a stringified
    // 0-based turn index, but assistant-ui message ids are opaque (non-numeric)
    // strings. The resolver therefore falls back to no-anchor behavior and
    // `anchorTurnIndex` is null. This assertion pins the v1 behavior; when
    // Task 14's follow-up wires a real turn-index through, this expectation
    // will flip to a numeric value and remind us to revisit the spec.
    expect(content.scope.anchorTurnIndex).toBeNull();
  });
});

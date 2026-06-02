// packages/web/e2e/integration/diagnostics-export.spec.ts
//
// E2E coverage for the self-service diagnostics export flow.
//
// Two entry points share one dialog:
//   1. Settings → Support → Generate (no anchor)
//   2. Per-message action bar → "Report issue to support" → Generate (anchor present)
//
// Architecture note — why one chat-turn for both tests:
//
// OpenClaw 2026.5.20 has a fence-detection race in its EmbeddedAttemptSession
// path: between `releaseForPrompt()` and the next `assertSessionFileFence()`,
// session-resume can append non-assistant entries (model_change, custom, …)
// to <sessionId>.jsonl. The fence treats those bytes as "external" writes
// and throws EmbeddedAttemptSessionTakeoverError, killing the in-flight turn.
//
// This was reproduced and the smoking gun captured by a runtime patch on
// sameSessionFileFingerprint:
//   {"reason":"stat-fields-diff", sameSize:false, sizeGrew:true,
//    sizeDeltaBytes:"252", ...}  ← 252 bytes ≈ one model_change event
//
// Trigger: a SECOND chat-turn on the same (user, agent) session within the
// same suite run. First turn creates the session cleanly; the resume on the
// second turn writes a non-assistant header line during the fence window.
// agent-chat.spec.ts isn't affected because each of its tests runs against
// a freshly-created session.
//
// We sidestep the upstream bug by doing ONE chat-turn (in beforeAll) and
// letting both tests share the resulting session state. That preserves end-
// to-end coverage of our feature (the diagnostics dialog + download flow)
// without exercising OpenClaw's resume code path. Tracked upstream:
//   https://github.com/openclawai/openclaw/issues (file when reduced).
//
// The serial describe ensures the beforeAll-set state is consumed in order
// and the tests can't be reordered to race.

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { FAKE_OLLAMA_RESPONSE } from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

/**
 * Clicks the dialog's Generate button, asserts the API returned 200, and
 * returns the download promise. Surfaces the API status + body on non-200
 * — much more informative than the default 120s "waiting for download"
 * timeout when something upstream fails.
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

test.describe.serial("Self-service diagnostics export", () => {
  let smithersAgentId: string;

  test.beforeAll(async ({ browser }) => {
    // Single chat-turn primes a real OpenClaw session for the whole describe.
    // Subsequent tests read from this session without resuming it — that's
    // what avoids the upstream fence race documented in the file header.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page);
      await waitForOpenClawConnected(page);
      smithersAgentId = await getSmithersAgentId(page);
      await page.goto(`/chat/${smithersAgentId}`);
      const input = page.getByPlaceholder(/send a message/i);
      await expect(input).toBeVisible({ timeout: 10000 });
      await input.fill("Diagnostic E2E seed turn");
      await input.press("Enter");
      // History from earlier specs (e.g. agent-chat.spec.ts) accumulates on
      // the shared Smithers agent, so FAKE_OLLAMA_RESPONSE may already match
      // on the page. `.last()` anchors on the newest match.
      await expect(page.getByText(FAKE_OLLAMA_RESPONSE).last()).toBeVisible({ timeout: 30000 });
    } finally {
      await context.close();
    }
  });

  test("Settings → Support → Generate produces a downloadable JSON file", async ({ page }) => {
    await login(page);
    await waitForOpenClawConnected(page);

    // Open Settings → Support. No chat-turn here — the beforeAll already
    // primed the session.
    await page.goto("/settings?tab=support");
    const openDialogButton = page.getByRole("button", { name: /generate diagnostics export/i });
    await expect(openDialogButton).toBeVisible({ timeout: 10000 });
    await openDialogButton.click();

    const download = await clickDialogGenerateAndAwaitDownload(page);
    expect(download.suggestedFilename()).toMatch(/^pinchy-bugreport-.+\.json$/);

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
    expect(content.scope.agentId).toBe(smithersAgentId);
    // No anchor was provided in the Settings flow.
    expect(content.scope.anchorTurnIndex).toBeNull();
  });

  test("Per-message Report issue downloads a bundle (v1 anchor=null limitation)", async ({
    page,
  }) => {
    await login(page);
    await waitForOpenClawConnected(page);

    // Load the chat. The beforeAll's turn is already in history; the
    // assistant message it produced is the one we hover.
    await page.goto(`/chat/${smithersAgentId}`);

    // Wait for the assistant message to render from history before hovering.
    const lastAssistant = page.locator('[data-role="assistant"]').last();
    await expect(lastAssistant).toBeVisible({ timeout: 30000 });
    await lastAssistant.hover();

    // Open the More menu and click Report-issue. Both data-testid attributes
    // were added in Task 16 specifically to make this flow reliable — the
    // role/text fallbacks were too ambiguous because assistant-ui renders
    // the trigger only on hover.
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
    expect(content.scope.agentId).toBe(smithersAgentId);

    // V1 limitation: the scope-resolver parses `anchorMessageId` as a stringified
    // 0-based turn index, but assistant-ui message ids are opaque (non-numeric)
    // strings. The resolver therefore falls back to no-anchor behavior and
    // `anchorTurnIndex` is null. This assertion pins the v1 behavior; when
    // Task 14's follow-up wires a real turn-index through, this expectation
    // will flip to a numeric value and remind us to revisit the spec.
    expect(content.scope.anchorTurnIndex).toBeNull();
  });
});

// packages/web/e2e/integration/upload-and-send.spec.ts
//
// Happy-path E2E: upload a PDF, send it, assert the message bubble uses the
// /api/agents/.../uploads/ URL (never a blob: URL), and assert zero 404s on
// any uploads fetch.
//
// Runs inside the full integration Docker stack (fake Ollama + OpenClaw + DB).
// To run locally: pnpm -C packages/web test:integration --grep "upload and send"
import { test, expect } from "@playwright/test";
import path from "path";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";
import { FAKE_OLLAMA_RESPONSE } from "../shared/fake-ollama/fake-ollama-server";

test.describe("upload and send — happy path", () => {
  test("PDF upload chip reaches ready state and message embed uses uploads URL with zero 404s", async ({
    page,
  }) => {
    // ── 1. Monitor for 404s on uploads endpoints before anything loads ────────
    const failedUploadFetches: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/uploads/") && response.status() === 404) {
        failedUploadFetches.push(response.url());
      }
    });

    // ── 2. Login and navigate to Smithers ─────────────────────────────────────
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // ── 3. Wait for OpenClaw to be connected ──────────────────────────────────
    await waitForOpenClawConnected(page);

    const input = page.getByLabel("Message input");
    await expect(input).toBeVisible({ timeout: 10000 });

    // ── 4. Click the attachment button and upload test.pdf ────────────────────
    const fixturesDir = path.join(__dirname, "../fixtures");
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator(".aui-composer-add-attachment").click(),
    ]);
    await fileChooser.setFiles(path.join(fixturesDir, "test.pdf"));

    // ── 5. Wait for the upload chip to show a green check (state = ready) ─────
    // The UploadChip renders a CheckCircle (text-green-600) when state = "ready".
    // We locate the chip by the filename text and assert the check icon is present
    // as a sibling. Using the aria-label "Remove upload" button as a stable
    // anchor ensures the chip container is what we found.
    const uploadChipContainer = page.locator('[aria-label="Remove upload"]').locator("..");
    await expect(uploadChipContainer).toBeVisible({ timeout: 15000 });

    // The CheckCircle SVG renders inside the chip only when state is "ready".
    // Lucide renders SVGs with role="img" — we look for the green-600 class.
    // Timeout covers network round-trip to POST /api/agents/.../uploads
    const readyChip = page
      .locator(".text-green-600")
      .locator("xpath=ancestor::*[@class and contains(@class,'rounded-lg')]")
      .first();
    await expect(readyChip).toBeVisible({ timeout: 20000 });

    // ── 6. Send the message ───────────────────────────────────────────────────
    await input.fill("What does this document say?");
    await page.keyboard.press("Enter");

    // ── 7. Wait for the fake Ollama response to appear ────────────────────────
    // .first() — the response may briefly render twice (streamed chunk + history
    // reconcile) before the canonical version settles. Strict-mode locator
    // matchers fail on >1 match; `.first()` is consistent with the same
    // assertion in agent-chat.spec.ts.
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE).first()).toBeVisible({ timeout: 30000 });

    // ── 8. Assert the user message contains the filename ─────────────────────
    // After send the composer chip disappears and the message bubble renders
    // AttachmentPreview / FilePart which shows the filename in the DOM.
    const userMessageRegion = page.locator('[data-role="user"]').last();
    await expect(userMessageRegion.getByText("test.pdf")).toBeVisible({ timeout: 10000 });

    // ── 9. Assert the embed/img in the message uses the uploads API URL ───────
    // AttachmentPreview renders <embed src="/api/agents/.../uploads/test.pdf" ...>
    // for PDFs. We verify the src attribute starts with the expected path so we
    // know the client is not serving a blob: URL from memory.
    const expectedUrlPrefix = `/api/agents/${agentId}/uploads/`;

    // Check <embed> (PDF) or <img> (image) — PDF fixture lands as <embed>
    const embedOrImg = userMessageRegion.locator("embed, img[src*='/uploads/']").first();
    await expect(embedOrImg).toBeAttached({ timeout: 10000 });
    const srcValue = await embedOrImg.getAttribute("src");
    expect(srcValue).toBeTruthy();
    expect(srcValue!.startsWith(expectedUrlPrefix)).toBe(true);
    expect(srcValue!.startsWith("blob:")).toBe(false);

    // ── 10. Assert zero 404s from uploads fetches ─────────────────────────────
    expect(failedUploadFetches).toHaveLength(0);
  });
});

import { test, expect } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";
import {
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
  FAKE_OLLAMA_SLOW_STREAM_DELAY_MS,
} from "./fake-ollama-server";

const RESPONSE_WORDS = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ");
const FIRST_WORD = RESPONSE_WORDS[0]!;
const LAST_WORD = RESPONSE_WORDS[RESPONSE_WORDS.length - 1]!;

test.describe("In-app navigation chat persistence (#199)", () => {
  async function login(page: Page) {
    const setup = await page.request.post("/api/setup", {
      data: {
        name: "Integration Admin",
        email: "admin@integration.local",
        password: "integration-password-123",
      },
    });
    expect([201, 403]).toContain(setup.status());
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@integration.local");
    await page.getByLabel("Password", { exact: true }).fill("integration-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
  }

  async function getSmithersAgentId(page: Page) {
    const res = await page.request.get("/api/agents");
    const agents = await res.json();
    const smithers = agents.find((a: { name: string }) => a.name === "Smithers");
    expect(smithers).toBeTruthy();
    return smithers.id as string;
  }

  async function waitForOpenClawConnected(page: Page, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let connectedSince: number | null = null;
    while (Date.now() < deadline) {
      const health = await page.request.get("/api/health/openclaw");
      const data = await health.json();
      if (data.connected) {
        connectedSince ??= Date.now();
        if (Date.now() - connectedSince >= 5000) return;
      } else {
        connectedSince = null;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`OpenClaw did not connect within ${timeoutMs}ms`);
  }

  test("mid-stream in-app navigation + return preserves the live stream", async ({ browser }) => {
    const ctx: BrowserContext = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const agentId = await getSmithersAgentId(page);

    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list ${FIRST_WORD}..${LAST_WORD}`);
    await input.press("Enter");

    // Wait for first token to confirm stream is live.
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: FIRST_WORD })
    ).toBeVisible({ timeout: 30000 });

    // In-app navigate away.
    await page.goto("/agents");

    // Wait for the stream to complete server-side.
    const remainingStreamMs = FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * RESPONSE_WORDS.length;
    await new Promise((r) => setTimeout(r, remainingStreamMs + 3000));

    // Navigate back to the chat.
    await page.goto(`/chat/${agentId}`);

    // Full assistant reply must be visible quickly — bundle was alive in the background.
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
      { timeout: 5000 }
    );

    await ctx.close();
  });
});

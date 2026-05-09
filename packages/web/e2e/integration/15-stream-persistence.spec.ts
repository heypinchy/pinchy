// packages/web/e2e/integration/15-stream-persistence.spec.ts
import { test, expect } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";
import {
  FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
  FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
  FAKE_OLLAMA_SLOW_STREAM_DELAY_MS,
} from "./fake-ollama-server";

test.describe("Stream persistence — #199 Layer A + B end-to-end", () => {
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

  test("user msg + reply survive mid-stream context-close", async ({ browser }) => {
    // First context: send a slow-streaming message, observe first token, then close.
    const ctx1: BrowserContext = await browser.newContext();
    const page1 = await ctx1.newPage();
    await login(page1);
    const agentId = await getSmithersAgentId(page1);

    await page1.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page1);

    const input = page1.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    const userText = `${FAKE_OLLAMA_SLOW_STREAM_TRIGGER}: list 1..5`;
    await input.fill(userText);
    await page1.getByRole("button", { name: /send/i }).click();

    // Wait for first assistant token to render — proves the stream is live.
    // data-role="assistant" is set on MessagePrimitive.Root in thread.tsx
    await expect(page1.locator('[data-role="assistant"]').last()).toContainText("one", {
      timeout: 15000,
    });

    // Close the entire context — simulates the user closing the tab/window
    // while OpenClaw is still streaming.
    await ctx1.close();

    // Allow remaining tokens to arrive on the server side.
    // Derived from stream parameters: 10 words × DELAY_MS + 3s CI buffer.
    const wordCount = FAKE_OLLAMA_SLOW_STREAM_RESPONSE.split(" ").length;
    await new Promise((r) => setTimeout(r, FAKE_OLLAMA_SLOW_STREAM_DELAY_MS * wordCount + 3000));

    // Fresh context — no shared cookies, no shared websocket.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await login(page2);
    await page2.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page2);

    // Layer A guard: the user message must be visible.
    // data-role="user" is set on MessagePrimitive.Root in thread.tsx
    await expect(page2.locator('[data-role="user"]').last()).toContainText(
      FAKE_OLLAMA_SLOW_STREAM_TRIGGER,
      { timeout: 15000 }
    );

    // Layer B guard: the assistant reply must be complete.
    // Assert on the *last* word so partial replies fail.
    await expect(page2.locator('[data-role="assistant"]').last()).toContainText("ten", {
      timeout: 15000,
    });

    // Final guard: the whole canonical reply is present.
    await expect(page2.locator('[data-role="assistant"]').last()).toContainText(
      FAKE_OLLAMA_SLOW_STREAM_RESPONSE,
      { timeout: 5000 }
    );

    await ctx2.close();
  });
});

// packages/web/e2e/integration/agent-chat.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Agent chat — full integration", () => {
  test("agent created through Pinchy responds to messages via OpenClaw", async ({ page }) => {
    // 1. Run setup wizard (creates admin + Smithers)
    const setup = await page.request.post("/api/setup", {
      data: {
        name: "Integration Admin",
        email: "admin@integration.local",
        password: "integration-password-123",
      },
    });
    expect([201, 403]).toContain(setup.status()); // 403 = already set up

    // 2. Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@integration.local");
    await page.getByLabel("Password", { exact: true }).fill("integration-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    // 3. Create a test agent via API (custom template = no plugin required)
    const agentRes = await page.request.post("/api/agents", {
      data: {
        name: "Integration Test Bot",
        templateId: "custom",
      },
    });
    expect(agentRes.status()).toBe(201);
    const agent = await agentRes.json();
    const agentId: string = agent.id;

    // 3b. Wait for OpenClaw to reload the config and pick up the new agent.
    // OpenClaw 2026.4.12+ crashes on "unknown agent id" (unlike older versions
    // which returned a graceful error). We must ensure the config reload has
    // completed before sending any message to this agent.
    // Strategy: poll until connected after a disconnect-reconnect cycle (config
    // reload) OR until 5 seconds have passed (file watcher had time to trigger
    // a seamless reload with no disconnect).
    const agentCreatedAt = Date.now();
    const configReloadDeadline = agentCreatedAt + 30000;
    const MIN_WAIT_MS = 5000;
    let wasEverDisconnected = false;
    while (Date.now() < configReloadDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      const health = await page.request.get("/api/health/openclaw");
      const data = await health.json();
      if (!data.connected) {
        wasEverDisconnected = true;
      } else if (wasEverDisconnected || Date.now() - agentCreatedAt >= MIN_WAIT_MS) {
        break;
      }
    }

    // 4. Navigate to the agent's chat page
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // 5. Wait for the chat input to appear (proves the agent loaded)
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // 6. Send a message
    await input.fill("Hello, are you there?");
    await input.press("Enter");

    // 7. Verify the fake Ollama response appears
    // Fake Ollama always responds: "Integration test response."
    await expect(page.getByText("Integration test response.")).toBeVisible({
      timeout: 30000, // Allow time for OpenClaw config reload + LLM call
    });
  });
});

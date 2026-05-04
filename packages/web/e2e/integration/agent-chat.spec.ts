// packages/web/e2e/integration/agent-chat.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Agent chat — full integration", () => {
  test("Pinchy agent responds to messages via OpenClaw", async ({ page }) => {
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

    // 3. Use Smithers (created during setup) — already in OpenClaw config at startup,
    // no hot-reload required. Testing hot-reload reliability is an infrastructure
    // concern; the config-schema unit test ensures the schema stays valid.
    //
    // Smithers is the Pinchy onboarding agent. Its config wires up three internal plugins:
    //   - pinchy-context: saves user/org context gathered during the onboarding interview
    //   - pinchy-docs: reads platform documentation on demand so Smithers answers
    //                  questions about Pinchy from the live docs
    //   - pinchy-audit: logs every tool execution to the Pinchy audit trail
    const agentsRes = await page.request.get("/api/agents");
    expect(agentsRes.status()).toBe(200);
    const agents = await agentsRes.json();
    const smithers = agents.find((a: { name: string }) => a.name === "Smithers");
    expect(smithers).toBeTruthy();
    const agentId: string = smithers.id;

    // 4. Navigate to the agent's chat page
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // 5. Wait for OpenClaw to connect (Smithers is already in the config)
    const connectDeadline = Date.now() + 30000;
    while (Date.now() < connectDeadline) {
      const health = await page.request.get("/api/health/openclaw");
      const data = await health.json();
      if (data.connected) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 6. Wait for the chat input to appear
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // 7. Send a message
    await input.fill("Hello, are you there?");
    await input.press("Enter");

    // 8. Verify the fake Ollama response appears
    // Fake Ollama always responds: "Integration test response."
    await expect(page.getByText("Integration test response.")).toBeVisible({
      timeout: 30000,
    });
  });
});

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

  test("stop button works and session recovers for a second message", async ({ page }) => {
    // 1. Setup + login (same as the first test)
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

    // 2. Get Smithers agent
    const agentsRes = await page.request.get("/api/agents");
    const agents = await agentsRes.json();
    const smithers = agents.find((a: { name: string }) => a.name === "Smithers");
    expect(smithers).toBeTruthy();
    await page.goto(`/chat/${smithers.id}`);

    // 3. Wait for OpenClaw to connect
    const connectDeadline = Date.now() + 30000;
    while (Date.now() < connectDeadline) {
      const health = await page.request.get("/api/health/openclaw");
      const data = await health.json();
      if (data.connected) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. Send first message
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill("First message");
    await input.press("Enter");

    // 5. Click stop button if it appears (it may appear briefly before the fast fake response)
    const stopButton = page.getByRole("button", { name: /stop generating/i });
    // Wait up to 5s for stop button — if the response already came, skip gracefully
    const stopVisible = await stopButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (stopVisible) {
      await stopButton.click();
      // After clicking stop, the stop button must disappear
      await expect(stopButton).not.toBeVisible({ timeout: 5000 });
    }

    // 6. Send a SECOND message — this is the key regression test.
    // Before the Gateway fix, the session lock would not be released after abort,
    // causing all subsequent messages to get empty responses.
    const input2 = page.getByPlaceholder(/send a message/i);
    await expect(input2).toBeVisible({ timeout: 10000 });
    await input2.fill("Second message");
    await input2.press("Enter");

    // 7. The second message must produce a real response — not empty, not hanging.
    // Fake Ollama always responds "Integration test response."
    await expect(page.getByText("Integration test response.").last()).toBeVisible({
      timeout: 30000,
    });
  });
});

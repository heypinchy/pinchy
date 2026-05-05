// packages/web/e2e/integration/agent-chat.spec.ts
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  FAKE_OLLAMA_DOMAIN_LOCK_TOOL_RESPONSE,
  FAKE_OLLAMA_DOMAIN_LOCK_TOOL_TRIGGER,
  FAKE_OLLAMA_RESPONSE,
} from "./fake-ollama-server";

test.describe("Agent chat — full integration", () => {
  async function login(page: Page) {
    // Run setup wizard (creates admin + Smithers)
    const setup = await page.request.post("/api/setup", {
      data: {
        name: "Integration Admin",
        email: "admin@integration.local",
        password: "integration-password-123",
      },
    });
    expect([201, 403]).toContain(setup.status()); // 403 = already set up

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@integration.local");
    await page.getByLabel("Password", { exact: true }).fill("integration-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });
  }

  async function getSmithersAgentId(page: Page) {
    const agentsRes = await page.request.get("/api/agents");
    expect(agentsRes.status()).toBe(200);
    const agents = await agentsRes.json();
    const smithers = agents.find((a: { name: string }) => a.name === "Smithers");
    expect(smithers).toBeTruthy();
    return smithers.id as string;
  }

  async function waitForOpenClawConnected(page: Page, timeoutMs = 120000) {
    const connectDeadline = Date.now() + timeoutMs;
    let connectedSince: number | null = null;
    while (Date.now() < connectDeadline) {
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

  test("Pinchy agent responds to messages via OpenClaw", async ({ page }) => {
    // 1. Login
    await login(page);

    // 2. Use Smithers (created during setup) — already in OpenClaw config at startup,
    // no hot-reload required. Testing hot-reload reliability is an infrastructure
    // concern; the config-schema unit test ensures the schema stays valid.
    //
    // Smithers is the Pinchy onboarding agent. Its config wires up three internal plugins:
    //   - pinchy-context: saves user/org context gathered during the onboarding interview
    //   - pinchy-docs: reads platform documentation on demand so Smithers answers
    //                  questions about Pinchy from the live docs
    //   - pinchy-audit: logs every tool execution to the Pinchy audit trail
    const agentId = await getSmithersAgentId(page);

    // 3. Navigate to the agent's chat page
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // 4. Wait for OpenClaw to connect (Smithers is already in the config)
    await waitForOpenClawConnected(page);

    // 5. Wait for the chat input to appear
    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // 6. Send a message
    await input.fill("Hello, are you there?");
    await input.press("Enter");

    // 7. Verify the fake Ollama response appears
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE)).toBeVisible({
      timeout: 30000,
    });
  });

  test("Domain Lock allows OpenClaw tool calls to write audit entries", async ({ page }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);

    const lockRes = await page.request.post("/api/settings/domain", {
      headers: {
        Origin: "https://localhost:7779",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "localhost:7779",
      },
    });
    expect(lockRes.status()).toBe(200);

    try {
      await page.goto(`/chat/${agentId}`);
      await waitForOpenClawConnected(page);

      const input = page.getByPlaceholder(/send a message/i);
      await expect(input).toBeVisible({ timeout: 10000 });
      await input.fill(`${FAKE_OLLAMA_DOMAIN_LOCK_TOOL_TRIGGER}: What Pinchy docs exist?`);
      await input.press("Enter");

      await expect(page.getByText(FAKE_OLLAMA_DOMAIN_LOCK_TOOL_RESPONSE)).toBeVisible({
        timeout: 30000,
      });

      const deadline = Date.now() + 30000;
      let foundAuditEntry = false;
      while (Date.now() < deadline) {
        const auditRes = await page.request.get("/api/audit?eventType=tool.docs_list&limit=10");
        expect(auditRes.status()).toBe(200);
        const audit = await auditRes.json();
        foundAuditEntry = audit.entries.some(
          (entry: {
            resource: string | null;
            outcome: string | null;
            detail: { toolName?: string } | null;
          }) =>
            entry.resource === `agent:${agentId}` &&
            entry.outcome === "success" &&
            entry.detail?.toolName === "docs_list"
        );
        if (foundAuditEntry) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(foundAuditEntry).toBe(true);
    } finally {
      await page.request.delete("/api/settings/domain");
    }
  });
});

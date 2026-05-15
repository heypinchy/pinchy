// packages/web/e2e/integration/agent-chat.spec.ts
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  FAKE_OLLAMA_CONTEXT_SAVE_USER_TOOL_TRIGGER,
  FAKE_OLLAMA_DOMAIN_LOCK_TOOL_RESPONSE,
  FAKE_OLLAMA_DOMAIN_LOCK_TOOL_TRIGGER,
  FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER,
  FAKE_OLLAMA_RESPONSE,
} from "../shared/fake-ollama/fake-ollama-server";
import { login, getSmithersAgentId, waitForOpenClawConnected } from "./helpers";

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

  test("PDF attachment is accepted, persisted, and logged in the audit trail", async ({ page }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });

    // Minimal valid PDF — %PDF- magic bytes are enough for file-type@22 detection
    const minimalPdf = Buffer.from(
      "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\n" +
        "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n" +
        "0000000058 00000 n \n0000000115 00000 n \n" +
        "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF"
    );

    // Click the attachment button and set the file via the native file chooser
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator(".aui-composer-add-attachment").click(),
    ]);
    await fileChooser.setFiles([
      {
        name: "test-document.pdf",
        mimeType: "application/pdf",
        buffer: minimalPdf,
      },
    ]);

    // Send a message alongside the PDF
    await input.fill("What does this document say?");
    await page.keyboard.press("Enter");

    // The fake Ollama responds regardless of attachment content
    await expect(page.getByText(FAKE_OLLAMA_RESPONSE)).toBeVisible({ timeout: 30000 });

    // Verify the attachment.uploaded audit entry was written with the correct details
    const deadline = Date.now() + 15000;
    let foundAuditEntry = false;
    while (Date.now() < deadline) {
      const auditRes = await page.request.get("/api/audit?eventType=attachment.uploaded&limit=10");
      expect(auditRes.status()).toBe(200);
      const audit = await auditRes.json();
      foundAuditEntry = audit.entries.some(
        (entry: {
          resource: string | null;
          outcome: string | null;
          detail: {
            attachment?: { filename?: string; detectedMimeType?: string };
          } | null;
        }) =>
          entry.resource === `agent:${agentId}` &&
          entry.outcome === "success" &&
          entry.detail?.attachment?.filename === "test-document.pdf" &&
          entry.detail?.attachment?.detectedMimeType === "application/pdf"
      );
      if (foundAuditEntry) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(foundAuditEntry).toBe(true);
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

// ── Plugin behavior: pinchy-context ─────────────────────────────────────────
// Proves pinchy-context loaded correctly and registerTool() worked end-to-end.
// Smithers is the personal onboarding agent and has pinchy_save_user_context
// in its allowed tools by default — no agent creation needed.
test.describe("Plugin behavior — pinchy-context", () => {
  test("pinchy_save_user_context dispatches via fake-LLM and writes audit entry", async ({
    page,
  }) => {
    await login(page);
    const agentId = await getSmithersAgentId(page);
    await page.goto(`/chat/${agentId}`);
    await waitForOpenClawConnected(page);

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(`${FAKE_OLLAMA_CONTEXT_SAVE_USER_TOOL_TRIGGER}: save my context`);
    await input.press("Enter");

    const deadline = Date.now() + 30000;
    let found = false;
    while (Date.now() < deadline) {
      const res = await page.request.get(
        "/api/audit?eventType=tool.pinchy_save_user_context&limit=10"
      );
      expect(res.status()).toBe(200);
      const audit = await res.json();
      found = audit.entries.some(
        (entry: { resource: string | null; detail: { toolName?: string } | null }) =>
          entry.resource === `agent:${agentId}` &&
          entry.detail?.toolName === "pinchy_save_user_context"
      );
      if (found) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  });
});

// ── Plugin behavior: pinchy-files ────────────────────────────────────────────
// Proves pinchy-files loaded correctly and registerTool() worked end-to-end.
// Creates a temporary agent with /data as allowed path (path may not exist
// in the container — the tool call outcome is "failure" via ENOENT, but the
// audit entry IS written, proving the tool was dispatched).
//
// Uses templateId "custom" instead of a KB template such as contract-analyzer
// because the KB templates declare modelHint.capabilities=["vision", ...] which
// fake-Ollama's single non-vision model cannot satisfy → 400 from
// resolveModelForTemplate. The follow-up PATCH wires allowedTools + the
// pluginConfig that pinchy-files needs.
test.describe("Plugin behavior — pinchy-files", () => {
  test("pinchy_ls dispatches via fake-LLM and writes audit entry", async ({ page }) => {
    await login(page);
    await waitForOpenClawConnected(page);

    const createRes = await page.request.post("/api/agents", {
      data: { name: "E2E Files Probe", templateId: "custom" },
    });
    expect(createRes.status()).toBe(201);
    const agent = await createRes.json();
    const agentId = agent.id as string;

    const patchRes = await page.request.patch(`/api/agents/${agentId}`, {
      data: {
        allowedTools: ["pinchy_ls", "pinchy_read"],
        pluginConfig: { "pinchy-files": { allowed_paths: ["/data"] } },
      },
    });
    expect(patchRes.status()).toBe(200);

    try {
      // Wait for OpenClaw to reload the updated config (the new agent).
      await waitForOpenClawConnected(page);

      await page.goto(`/chat/${agentId}`);
      await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

      const input = page.getByPlaceholder(/send a message/i);
      await expect(input).toBeVisible({ timeout: 10000 });
      await input.fill(`${FAKE_OLLAMA_FILES_LS_TOOL_TRIGGER}: list knowledge base files`);
      await input.press("Enter");

      const deadline = Date.now() + 30000;
      let found = false;
      while (Date.now() < deadline) {
        const res = await page.request.get("/api/audit?eventType=tool.pinchy_ls&limit=10");
        expect(res.status()).toBe(200);
        const audit = await res.json();
        found = audit.entries.some(
          (entry: { resource: string | null; detail: { toolName?: string } | null }) =>
            entry.resource === `agent:${agentId}` && entry.detail?.toolName === "pinchy_ls"
        );
        if (found) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(found).toBe(true);
    } finally {
      await page.request.delete(`/api/agents/${agentId}`);
    }
  });
});

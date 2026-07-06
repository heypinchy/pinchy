import { test, expect } from "@playwright/test";
import {
  seedSetup,
  waitForPinchy,
  waitForImapMock,
  resetImapMailbox,
  seedImapMessage,
  getImapMessages,
  getGreenmailMailboxMessages,
  createImapConnectionInDb,
  getAdminEmail,
  getAdminPassword,
  login,
  pinchyGet,
  pinchyPost,
  pinchyPut,
  pinchyPatch,
  pinchyDelete,
  waitForOpenClawConnected,
} from "./helpers";
import {
  FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER,
  FAKE_OLLAMA_EMAIL_SEARCH_TOOL_TRIGGER,
  FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
  stopFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import {
  loginViaUI,
  pollAuditForTool,
  seedDefaultProviderToOllama,
  waitForOpenClawStable,
} from "../shared/dispatch-probe";
import { stackDbUrl } from "../shared/stack-db";

// Mailbox identity the imap-mock sidecar authenticates as against GreenMail
// (config/imap-mock/server.js's MOCK_USER default) — must match the
// `emailAddress` seeded via createImapConnectionInDb so the plugin's
// ImapAdapter (redirected to GreenMail via IMAP_MOCK_HOST/SMTP_MOCK_HOST) and
// the sidecar operate on the same GreenMail mailbox.
const MOCK_MAILBOX = "mock@example.com";

test.describe("pinchy-email — IMAP/SMTP E2E", () => {
  let cookie: string;
  let agentId: string;
  let connectionId: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(300000);
    await seedSetup();
    await waitForPinchy();
    await waitForImapMock();
    await resetImapMailbox();
    cookie = await login();

    // Get Smithers agent ID early — /api/agents is a DB query and does not
    // require OC to be connected. We need the ID before the DELETE below.
    const agents = await pinchyGet("/api/agents", cookie);
    expect(agents.status).toBe(200);
    const agentList = (await agents.json()) as Array<{ name: string; id: string }>;
    const smithers = agentList.find((a) => a.name === "Smithers");
    if (!smithers) throw new Error("Smithers agent not found — was seedSetup successful?");
    agentId = smithers.id;

    // Clear any pre-existing email integrations for Smithers (e.g. left behind
    // by another email E2E spec running in the same job). Done here — before
    // the rate-limit sleep — so the resulting regenerateOpenClawConfig call is
    // covered by the 35s wait below.
    await fetch(
      (process.env.PINCHY_URL || "http://localhost:7777") + `/api/agents/${agentId}/integrations`,
      {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: process.env.PINCHY_URL || "http://localhost:7777",
        },
      }
    );

    // Wait for OpenClaw to settle after the setup wizard restart and the DELETE
    // above (which may trigger a full gateway restart if prior permissions
    // were present). Both restarts are covered by this single wait.
    const settled = await waitForOpenClawConnected(cookie, 120000);
    if (!settled) throw new Error("OpenClaw did not reconnect after setup wizard");

    // Allow the config.apply rate-limit window to clear (~25s). This covers
    // seedSetup's calls AND the DELETE above. The next config.apply from test
    // 1's permission grant must fire cleanly — a rate-limited grant falls back
    // to 60s inotify, too slow for the chat tests.
    await new Promise((r) => setTimeout(r, 35000));
  });

  test("pinchy-email plugin loads after IMAP connection is configured (staging regression)", async () => {
    // This test guards against the scenario where pinchy-email is not in the
    // extensions volume, so OpenClaw logs "plugin not found" and the email
    // tools are never registered.
    //
    // Proof: if the plugin loaded, OpenClaw can generate config with
    // pinchy-email enabled and stays connected. We verify this by granting
    // email permissions and confirming OpenClaw remains connected (i.e. the
    // regenerated config was accepted, not rejected with INVALID_CONFIG).

    // Insert IMAP connection directly into DB (the create-then-test UI flow
    // is exercised elsewhere; here we only need a working connection row).
    const conn = await createImapConnectionInDb("Test IMAP", MOCK_MAILBOX);
    connectionId = conn.id;
    expect(conn.type).toBe("imap");

    // Grant email read permissions to Smithers via the integrations API
    const permRes = await fetch(
      (process.env.PINCHY_URL || "http://localhost:7777") + `/api/agents/${agentId}/integrations`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: process.env.PINCHY_URL || "http://localhost:7777",
        },
        body: JSON.stringify({
          connectionId,
          // Exactly the shape the permission UI writes: read/draft/send only.
          permissions: [{ model: "email", operation: "read" }],
        }),
      }
    );
    expect(permRes.status).toBe(200);

    // Poll OpenClaw until connected (config was hot-reloaded and accepted).
    // Granting pinchy-email adds a new plugin entry — OpenClaw does a full
    // restart. Give 120s to cover the restart + reconnect window.
    const connected = await waitForOpenClawConnected(cookie, 120000);
    expect(connected).toBe(true);

    // The IMAP connection is visible in the integrations list
    const integrations = await pinchyGet("/api/integrations", cookie);
    expect(integrations.status).toBe(200);
    const list = (await integrations.json()) as Array<{ type: string; id: string }>;
    const imapConn = list.find((c) => c.type === "imap");
    expect(imapConn).toBeDefined();
    expect(imapConn!.id).toBe(connectionId);
  });

  test("agent permissions model — read-only agent does not have send or draft operations", async () => {
    // Verify that the permissions set in test 1 (read only — the exact shape
    // the UI writes) are correctly reflected in the integrations API.
    //
    // The connectionId is set by test 1 above.
    if (!connectionId) {
      throw new Error("connectionId not set — did test 1 run successfully?");
    }

    const integrationsRes = await pinchyGet(`/api/agents/${agentId}/integrations`, cookie);
    expect(integrationsRes.status).toBe(200);

    const integrations = (await integrationsRes.json()) as Array<{
      connectionId: string;
      connectionType: string;
      permissions: Array<{ model: string; operation: string }>;
    }>;

    const emailIntegration = integrations.find((i) => i.connectionId === connectionId);
    expect(emailIntegration).toBeDefined();
    expect(emailIntegration!.connectionType).toBe("imap");

    const ops = emailIntegration!.permissions.map((p) => p.operation);
    expect(ops).toEqual(["read"]);
    expect(ops).not.toContain("send");
    expect(ops).not.toContain("draft");
  });
});

// ── Dispatch probe (pinchy-email plugin coverage, IMAP/SMTP) ────────────────
// Mirrors the Gmail/Microsoft dispatch probes: switches the default provider
// to host fake-Ollama for this describe block only (via the allowed
// `ollama.local` alias), creates a disposable agent with an IMAP connection
// and the email tools allowed, and asserts the fake-LLM trigger drives real
// IMAP/SMTP traffic against GreenMail.
//
// GreenMail exposes plainly-named folders (INBOX, Sent, ...) with no
// SPECIAL-USE attributes, unlike Gmail/Graph mocks that fake labelled
// folders. This means every dispatch below naturally exercises the
// ImapAdapter's name-heuristic folder resolution (matching folder names like
// "Sent" by string rather than a SPECIAL-USE flag) rather than the flagged
// path exercised by the other providers' mocks.
test.describe("IMAP/SMTP email dispatch probe (pinchy-email plugin coverage)", () => {
  let dispatchCookie: string;
  let dispatchConnectionId: string;
  let dispatchAgentId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(240_000);

    // 1. Start fake-Ollama on the host (port 11435).
    await startFakeOllama();

    // 2. Swap default_provider to ollama-local and seed ollama_local_url
    //    (points at host fake-Ollama via the allowed `ollama.local` alias).
    const dbUrl = process.env.DATABASE_URL || stackDbUrl(5434);
    restoreSettings = await seedDefaultProviderToOllama(dbUrl, FAKE_OLLAMA_PORT);

    // 3. Login (API cookie).
    dispatchCookie = await login();

    // 4. Create IMAP connection so the agent config includes the plugin block.
    const conn = await createImapConnectionInDb("E2E IMAP Dispatch", MOCK_MAILBOX);
    dispatchConnectionId = conn.id;

    // 5. Create the dispatch agent.
    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E IMAP Dispatch Probe", templateId: "custom" },
      dispatchCookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    dispatchAgentId = ((await createRes.json()) as { id: string }).id;

    // 6. Grant email read + send permissions → triggers regenerateOpenClawConfig().
    //    Grant `send` here too so the send round-trip test below doesn't have to
    //    do a second permissions edit (each edit costs a config-apply rate-limit).
    const permRes = await pinchyPut(
      `/api/agents/${dispatchAgentId}/integrations`,
      {
        connectionId: dispatchConnectionId,
        permissions: [
          { model: "email", operation: "read" },
          { model: "email", operation: "send" },
        ],
      },
      dispatchCookie
    );
    if (permRes.status !== 200)
      throw new Error(`Permissions grant failed: ${String(permRes.status)}`);

    // 7. Allow email_list + email_search + email_send — second config regen
    //    with the tools in the allow-list. email_search is deliberately backed
    //    ONLY by the "read" permission granted above (no "search" row exists in
    //    UI-written data) — the search dispatch test below proves that grant
    //    shape is sufficient end-to-end (parity with the Microsoft spec's
    //    regression coverage for f62f50045).
    const patchRes = await pinchyPatch(
      `/api/agents/${dispatchAgentId}`,
      { allowedTools: ["email_list", "email_search", "email_send"] },
      dispatchCookie
    );
    if (patchRes.status !== 200) throw new Error(`Agent patch failed: ${String(patchRes.status)}`);

    // 8. Wait for OpenClaw to stabilise with the new Ollama config.
    await waitForOpenClawStable(() => pinchyGet("/api/health/openclaw", dispatchCookie));
  });

  test.afterAll(async () => {
    if (dispatchAgentId) {
      await pinchyDelete(`/api/agents/${dispatchAgentId}`, dispatchCookie);
    }
    if (dispatchConnectionId) {
      await pinchyDelete(`/api/integrations/${dispatchConnectionId}`, dispatchCookie);
    }
    if (restoreSettings) await restoreSettings();
    await stopFakeOllama();
  });

  test.beforeEach(async () => {
    // Isolation between mailbox-content-asserting tests below.
    await resetImapMailbox();
  });

  test("email_list dispatches via fake-LLM and writes audit entry", async ({ page }, testInfo) => {
    // 160 s poll past the 150 s chatWithDispatchRaceRetry budget; 180 s per-test
    // timeout to outlast it.
    testInfo.setTimeout(180_000);

    // Pre-seed a message so there is something in INBOX to list, delivered
    // via a real SMTP send into GreenMail (see seedImapMessage).
    await seedImapMessage({
      to: MOCK_MAILBOX,
      from: "sender@example.com",
      subject: "Test email from imap-mock",
      body: "Hello from IMAP E2E test",
    });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());

    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_LIST_TOOL_TRIGGER}: list my emails`);
    await input.press("Enter");

    const found = await pollAuditForTool(page, {
      toolName: "email_list",
      agentId: dispatchAgentId,
      since,
      deadlineMs: 160_000,
    });
    expect(found).toBe(true);

    // The pre-seeded message must still be visible in GreenMail via the real
    // IMAP protocol — the round-trip proof that the adapter read through to
    // the actual mailbox (email_list's rendered output is not independently
    // observable through the chat UI, same caveat as email_read/email_draft
    // noted in email-gmail.spec.ts, so the mailbox-state check stands in for
    // the LLM-visible result).
    const messages = await getImapMessages();
    expect(messages.some((m) => m.subject === "Test email from imap-mock")).toBe(true);
  });

  // Regression guard mirroring the Microsoft spec's f62f50045 coverage: the
  // agent above holds ONLY the read/send permission rows the UI actually
  // writes — no "search" row exists. email_search must still dispatch,
  // because search is part of "read" (build.ts derives the plugin tools via
  // getEmailToolsForOperations, and the plugin gates email_search behind the
  // "read" permission).
  test("email_search dispatches with only a read grant (no 'search' permission row)", async ({
    page,
  }) => {
    await seedImapMessage({
      to: MOCK_MAILBOX,
      from: "sender@example.com",
      subject: "Searchable message",
      body: "Findable by the search probe",
    });

    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_SEARCH_TOOL_TRIGGER}: find mail from sender`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_search",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);
  });

  test("greenmail receives email_send request when tool is invoked via chat", async ({ page }) => {
    await loginViaUI(page, getAdminEmail(), getAdminPassword());
    await page.goto(`/chat/${dispatchAgentId}`);
    await expect(page).toHaveURL(`/chat/${dispatchAgentId}`, { timeout: 10_000 });

    const input = page.getByPlaceholder(/send a message/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    const since = new Date().toISOString();
    await input.fill(`${FAKE_OLLAMA_EMAIL_SEND_TOOL_TRIGGER}: round-trip send`);
    await input.press("Enter");

    const dispatched = await pollAuditForTool(page, {
      toolName: "email_send",
      agentId: dispatchAgentId,
      since,
    });
    expect(dispatched).toBe(true);

    // The plugin must have sent the message through the real SMTP protocol
    // to GreenMail. The fake-LLM trigger's fixed arguments target
    // "probe@example.com" (see fake-ollama-server.ts's EMAIL_SEND_TRIGGER
    // config) — a DIFFERENT mailbox than the connection under test
    // (mock@example.com). GreenMail is started with `-Dgreenmail.auth.disabled`
    // and creates mailboxes on demand, so we connect directly over IMAP as
    // probe@example.com (bypassing the imap-mock sidecar, which is fixed to
    // MOCK_USER) to prove the message actually landed.
    const messages = await getGreenmailMailboxMessages("probe@example.com");
    expect(messages.some((m) => m.subject === "Pinchy E2E probe")).toBe(true);
  });
});

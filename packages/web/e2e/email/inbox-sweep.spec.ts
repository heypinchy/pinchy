/**
 * Inbox Agent (#139) — the reconciliation sweep, end to end and unprompted.
 *
 * Every layer below this is covered against an injected seam: the sweep engine
 * against fake ports, the ports against a mocked fetch/imapflow, the run adapter
 * against a mock gateway client. All of them share one blind spot — they are
 * *called by the test*. The single claim none of them can make is the one the
 * whole feature rests on:
 *
 *   mail lands in a real mailbox, and Pinchy acts on it with nobody asking.
 *
 * So this spec never triggers a sweep. It seeds a workflow and a message, then
 * waits for Pinchy's own cadence (INBOX_SWEEP_INTERVAL_MS, 5s here instead of
 * the 15-minute production interval) to notice. If the boot wiring in server.ts
 * were missing or the port could not reach the mailbox, nothing would ever
 * happen and this test would time out — which is exactly the failure that
 * every green unit test would still hide.
 *
 * IMAP is the provider under test on purpose: GreenMail is a real IMAP server,
 * so the port's one-connection lifecycle is exercised for real, and its host
 * comes out of the connection's stored credentials rather than an env override.
 */
import { test, expect } from "@playwright/test";

import {
  FAKE_OLLAMA_INBOX_SWEEP_TRIGGER,
  FAKE_OLLAMA_PORT,
  startFakeOllama,
} from "../shared/fake-ollama/fake-ollama-server";
import { seedDefaultProviderToOllama } from "../shared/dispatch-probe";
import { stackDbUrl } from "../shared/stack-db";
import {
  createGreenmailImapConnectionInDb,
  getProcessedEmails,
  login,
  pinchyPost,
  pinchyPut,
  resetImapMailbox,
  seedEmailWorkflow,
  seedImapMessage,
  seedSetup,
  waitForImapMock,
  waitForOpenClawConnected,
  waitForPinchy,
} from "./helpers";

const MOCK_MAILBOX = "mock@example.com";

test.describe("Inbox Agent — the sweep dispatches with no manual trigger", () => {
  let cookie: string;
  let agentId: string;
  let connectionId: string;
  let restoreSettings: (() => Promise<void>) | null = null;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(240_000);

    await waitForPinchy();
    await waitForImapMock();
    await seedSetup();

    // The run is a normal OpenClaw chat turn, so it needs a provider: point the
    // default at fake-Ollama on the host, which answers the inbox trigger with
    // a report block (see FAKE_OLLAMA_INBOX_SWEEP_TRIGGER).
    await startFakeOllama();
    restoreSettings = await seedDefaultProviderToOllama(
      process.env.DATABASE_URL || stackDbUrl(5434),
      FAKE_OLLAMA_PORT
    );

    cookie = await login();

    const conn = await createGreenmailImapConnectionInDb("E2E Sweep IMAP", MOCK_MAILBOX);
    connectionId = conn.id;

    const createRes = await pinchyPost(
      "/api/agents",
      { name: "E2E Inbox Sweep Agent", templateId: "custom" },
      cookie
    );
    if (createRes.status !== 201)
      throw new Error(`Agent creation failed: ${String(createRes.status)}`);
    agentId = ((await createRes.json()) as { id: string }).id;

    // The agent reads its own mail during the run, so it needs the grant —
    // and this is what puts the plugin block into its OpenClaw config.
    const permRes = await pinchyPut(
      `/api/agents/${agentId}/integrations`,
      { connectionId, permissions: [{ model: "email", operation: "read" }] },
      cookie
    );
    if (permRes.status !== 200)
      throw new Error(`Permissions grant failed: ${String(permRes.status)}`);

    // The readiness gate defers every run until the agent is in OC's runtime;
    // without this the first sweeps would defer and burn the spec's budget.
    await waitForOpenClawConnected(cookie);
  });

  test.afterAll(async () => {
    if (restoreSettings) await restoreSettings();
  });

  test("processes a mail nobody asked it to process", async () => {
    test.setTimeout(180_000);

    await resetImapMailbox();

    const subject = `E2E sweep probe ${Date.now()}`;
    const workflowId = await seedEmailWorkflow({
      agentId,
      connectionId,
      name: "E2E Inbox Sweep",
      // The trigger rides in the action: the run adapter renders it into the
      // task message as `Task: <action>`, which is what fake-Ollama matches.
      action: `${FAKE_OLLAMA_INBOX_SWEEP_TRIGGER}: file this invoice`,
      // Scope to this run's mail only, so a stray message in the shared
      // mailbox cannot make this test pass for the wrong reason.
      filter: { subjectContains: [subject] },
    });

    await seedImapMessage({
      to: MOCK_MAILBOX,
      from: "supplier@example.com",
      subject,
      body: "Please find the invoice attached.",
    });

    // From here on the test does NOTHING but watch. Every state change below is
    // Pinchy acting on its own cadence.
    await expect
      .poll(
        async () => {
          const rows = await getProcessedEmails(workflowId);
          return rows[0]?.status ?? "none";
        },
        {
          message:
            "the sweep never dispatched the seeded mail — check that server.ts starts it and that the port reaches GreenMail",
          timeout: 120_000,
          intervals: [2000],
        }
      )
      .toBe("done");

    const rows = await getProcessedEmails(workflowId);
    expect(rows).toHaveLength(1);
    // The outcome proves the agent RAN and its report was parsed — not merely
    // that a ledger row was claimed. A claim alone would also be `done`-less,
    // but a wrong-shaped report would finalize `failed`, so pin the payload.
    expect(rows[0].outcome).toMatchObject({ note: "e2e-inbox-sweep" });
    expect(rows[0].runId).toBeTruthy();
    expect(rows[0].messageIdHeader).toBeTruthy();
  });
});
